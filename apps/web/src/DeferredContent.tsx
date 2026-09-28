import { Component, Suspense, type ReactNode } from "react";

type Props = { children: ReactNode; fallback: ReactNode; onClose?: () => void };

// A failed chunk download must not unmount the app or interrupt an active call.
export class DeferredContent extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <div className="app-banner warning" role="alert">
      <span>Cette rubrique n’a pas pu être chargée. Vérifiez votre connexion, puis rechargez la page après avoir terminé vos appels.</span>
      {this.props.onClose && <button className="text-button" onClick={this.props.onClose}>Fermer</button>}
    </div>;
    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}
