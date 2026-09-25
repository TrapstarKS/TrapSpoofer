import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { getTranslation } from '../../utils/i18n';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('TrapSpoofer UI crashed:', error, errorInfo.componentStack);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen w-screen bg-bg-base text-text-primary p-8 text-center space-y-4 font-sans antialiased">
          <div className="text-red-500 mb-4">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">
            {getTranslation(useLanguage.getState().lang, 'misc.errorBoundaryTitle')}
          </h1>
          <p className="text-text-muted max-w-md">
            {getTranslation(useLanguage.getState().lang, 'misc.errorBoundaryDesc')}
          </p>
          <div className="bg-bg-card border border-border p-4 rounded-xl mt-4 max-w-2xl text-left overflow-auto max-h-48 text-sm w-full font-mono shadow-inner">
            <div className="text-red-400 font-semibold mb-2">
              {this.state.error?.name}: {this.state.error?.message}
            </div>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-6 py-3 bg-primary text-primary-content font-semibold rounded-xl hover:bg-primary-hover transition-colors shadow-lg active:scale-95"
          >
            {getTranslation(useLanguage.getState().lang, 'misc.reloadApplication')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
