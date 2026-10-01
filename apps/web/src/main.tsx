import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { VaultGate } from './components/VaultGate';
import './styles.css';
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="app-loading">
        <h1>The workspace hit a problem.</h1>
        <p>Your saved documents remain in browser storage.</p>
        <p>{this.state.error}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Reopen workspace
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <VaultGate>
      <App />
    </VaultGate>
  </ErrorBoundary>,
);
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* UI continues online if offline shell registration fails. */
    });
  });
}
