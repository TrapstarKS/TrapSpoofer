import CredentialsSection from '../config/CredentialsSection';

/** "Perfis Roblox" shortcut card shown at the top of Configurações > Geral. */
export default function CredentialsCard() {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-surface/50">
      <CredentialsSection />
    </section>
  );
}
