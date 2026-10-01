use futures::{stream, StreamExt};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

const POSITIVE_TTL: Duration = Duration::from_secs(300);
const MAX_CACHE_ENTRIES: usize = 512;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct DiscoveryKey {
    creator_type: String,
    creator_id: u64,
    authentication: String,
}

impl DiscoveryKey {
    pub(super) fn new(creator_type: &str, creator_id: u64, cookie: &str) -> Option<Self> {
        let creator_type = creator_type.trim().to_ascii_lowercase();
        if creator_id == 0 || !matches!(creator_type.as_str(), "user" | "group") {
            return None;
        }
        Some(Self {
            creator_type,
            creator_id,
            authentication: crate::utils::normalize_roblox_cookie(cookie),
        })
    }
}

struct Cached<T> {
    value: T,
    expires_at: Instant,
}

type Flight<T> = AsyncMutex<Option<T>>;

struct CacheState<T> {
    entries: HashMap<DiscoveryKey, Cached<T>>,
    flights: HashMap<DiscoveryKey, Weak<Flight<T>>>,
}

pub(super) struct DiscoveryCache<T> {
    state: Mutex<CacheState<T>>,
}

impl<T: Clone> DiscoveryCache<T> {
    pub(super) fn new() -> Self {
        Self { state: Mutex::new(CacheState { entries: HashMap::new(), flights: HashMap::new() }) }
    }

    pub(super) async fn get_or_fetch(
        &self,
        key: DiscoveryKey,
        fetch: impl Future<Output = T>,
        is_positive: impl FnOnce(&T) -> bool,
    ) -> T {
        self.get_or_fetch_with_clock(key, fetch, is_positive, Instant::now).await
    }

    async fn get_or_fetch_with_clock(
        &self,
        key: DiscoveryKey,
        fetch: impl Future<Output = T>,
        is_positive: impl FnOnce(&T) -> bool,
        now: impl Fn() -> Instant,
    ) -> T {
        let flight = {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let time = now();
            state.entries.retain(|_, entry| entry.expires_at > time);
            state.flights.retain(|_, flight| flight.strong_count() > 0);
            if let Some(entry) = state.entries.get(&key) {
                return entry.value.clone();
            }
            let flight = state
                .flights
                .get(&key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(AsyncMutex::new(None)));
            state.flights.insert(key.clone(), Arc::downgrade(&flight));
            flight
        };
        let mut result = flight.lock().await;
        if let Some(value) = result.as_ref() {
            return value.clone();
        }
        let value = fetch.await;
        if is_positive(&value) {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.entries.len() >= MAX_CACHE_ENTRIES {
                if let Some(oldest) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.expires_at)
                    .map(|(key, _)| key.clone())
                {
                    state.entries.remove(&oldest);
                }
            }
            state
                .entries
                .insert(key, Cached { value: value.clone(), expires_at: now() + POSITIVE_TTL });
        }
        *result = Some(value.clone());
        value
    }
}

pub(super) async fn collect_discoveries<F: Future>(
    fetches: impl IntoIterator<Item = F>,
) -> Vec<F::Output> {
    stream::iter(fetches).buffered(4).collect().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::task::noop_waker_ref;
    use std::cell::Cell;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll};

    fn key(kind: &str, id: u64, cookie: &str) -> DiscoveryKey {
        DiscoveryKey::new(kind, id, cookie).expect("valid discovery scope")
    }

    #[tokio::test]
    async fn positive_hits_expire_without_refreshing_the_deadline() {
        let cache = DiscoveryCache::new();
        let start = Instant::now();
        let time = Cell::new(start);
        let calls = Cell::new(0);
        let fetch = || async {
            calls.set(calls.get() + 1);
            vec![calls.get()]
        };
        for (seconds, expected) in [(0, 1), (299, 1), (300, 2), (301, 2), (600, 3)] {
            time.set(start + Duration::from_secs(seconds));
            let result = cache
                .get_or_fetch_with_clock(
                    key("user", 42, "account-a"),
                    fetch(),
                    |values| !values.is_empty(),
                    || time.get(),
                )
                .await;
            assert_eq!(result, vec![expected]);
            assert_eq!(calls.get(), expected);
        }
    }

    #[tokio::test]
    async fn normalized_keys_isolate_creator_type_id_and_authentication() {
        let cache = DiscoveryCache::new();
        let scopes = [
            ("User", 42, ".ROBLOSECURITY=account-a; Path=/", 1),
            (" user ", 42, " account-a ", 1),
            ("GROUP", 42, "account-a", 3),
            ("group", 42, ".ROBLOSECURITY=account-a", 3),
            ("user", 42, "account-b", 5),
            ("user", 43, "account-a", 6),
        ];
        for (index, (kind, id, cookie, expected)) in scopes.into_iter().enumerate() {
            let result = cache
                .get_or_fetch(key(kind, id, cookie), async { vec![index + 1] }, |values| {
                    !values.is_empty()
                })
                .await;
            assert_eq!(result, vec![expected]);
        }
        assert!(DiscoveryKey::new("", 42, "account-a").is_none());
        assert!(DiscoveryKey::new("organization", 42, "account-a").is_none());
        assert!(DiscoveryKey::new("user", 0, "account-a").is_none());
    }

    #[tokio::test]
    async fn cache_evicts_oldest_entries_at_capacity_and_prunes_expired_scopes() {
        let cache = DiscoveryCache::new();
        let start = Instant::now();
        let time = Cell::new(start);
        for id in 1..=MAX_CACHE_ENTRIES as u64 + 1 {
            time.set(start + Duration::from_millis(id));
            cache
                .get_or_fetch_with_clock(
                    key("user", id, "account-a"),
                    async { vec![id] },
                    |values| !values.is_empty(),
                    || time.get(),
                )
                .await;
        }
        {
            let state = cache.state.lock().expect("cache state");
            assert_eq!(state.entries.len(), MAX_CACHE_ENTRIES);
            assert!(!state.entries.contains_key(&key("user", 1, "account-a")));
            assert!(state.entries.contains_key(&key("user", 2, "account-a")));
            assert!(state.flights.len() <= 1);
        }
        time.set(start + POSITIVE_TTL + Duration::from_secs(1));
        cache
            .get_or_fetch_with_clock(
                key("group", 1, "account-b"),
                async { vec![1] },
                |values| !values.is_empty(),
                || time.get(),
            )
            .await;
        assert_eq!(cache.state.lock().expect("cache state").entries.len(), 1);
    }

    #[tokio::test]
    async fn absence_and_failed_fetches_are_not_cached_for_the_next_attempt() {
        let cache = DiscoveryCache::new();
        let scope = key("user", 42, "account-a");
        for value in [None, Some(Vec::<u64>::new())] {
            let result = cache
                .get_or_fetch(scope.clone(), async { value.clone() }, |value| {
                    value.as_ref().is_some_and(|values| !values.is_empty())
                })
                .await;
            assert_eq!(result, value);
        }
        let recovered = cache
            .get_or_fetch(scope, async { Some(vec![99]) }, |value| {
                value.as_ref().is_some_and(|values| !values.is_empty())
            })
            .await;
        assert_eq!(recovered, Some(vec![99]));
    }

    #[tokio::test]
    async fn simultaneous_misses_share_one_fetch_including_empty_results() {
        for values in [vec![], vec![99]] {
            let cache = DiscoveryCache::new();
            let calls = Cell::new(0);
            let futures = (0..20).map(|_| {
                cache.get_or_fetch(
                    key("user", 42, "account-a"),
                    async {
                        calls.set(calls.get() + 1);
                        tokio::task::yield_now().await;
                        values.clone()
                    },
                    |values| !values.is_empty(),
                )
            });
            let results = futures::future::join_all(futures).await;
            assert_eq!(calls.get(), 1);
            assert!(results.iter().all(|result| result == &values));
            let next = cache
                .get_or_fetch(key("user", 42, "account-a"), async { vec![100] }, |values| {
                    !values.is_empty()
                })
                .await;
            assert_eq!(next, if values.is_empty() { vec![100] } else { values });
        }
    }

    struct PendingFetch {
        started: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
        was_started: bool,
    }

    impl Future for PendingFetch {
        type Output = Vec<u64>;

        fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
            if !self.was_started {
                self.was_started = true;
                self.started.fetch_add(1, Ordering::SeqCst);
            }
            Poll::Pending
        }
    }

    impl Drop for PendingFetch {
        fn drop(&mut self) {
            if self.was_started {
                self.dropped.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    #[tokio::test]
    async fn dropping_a_fetch_releases_its_waiters_to_retry() {
        let cache = DiscoveryCache::new();
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut first = Box::pin(cache.get_or_fetch(
            key("user", 42, "account-a"),
            PendingFetch {
                started: Arc::clone(&started),
                dropped: Arc::clone(&dropped),
                was_started: false,
            },
            |values| !values.is_empty(),
        ));
        let mut second = Box::pin(cache.get_or_fetch(
            key("user", 42, "account-a"),
            async { vec![99] },
            |values| !values.is_empty(),
        ));
        let mut context = Context::from_waker(noop_waker_ref());
        assert!(first.as_mut().poll(&mut context).is_pending());
        assert!(second.as_mut().poll(&mut context).is_pending());
        drop(first);
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(second.await, vec![99]);
    }

    #[test]
    fn graph_fetches_are_bounded_and_dropped_with_the_parent() {
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let fetches = (0..20).map(|_| PendingFetch {
            started: Arc::clone(&started),
            dropped: Arc::clone(&dropped),
            was_started: false,
        });
        let mut parent = Box::pin(collect_discoveries(fetches));
        let mut context = Context::from_waker(noop_waker_ref());
        assert!(parent.as_mut().poll(&mut context).is_pending());
        assert_eq!(started.load(Ordering::SeqCst), 4);
        drop(parent);
        assert_eq!(dropped.load(Ordering::SeqCst), 4);
    }
}
