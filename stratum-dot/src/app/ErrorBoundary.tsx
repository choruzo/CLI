import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Qué se enseña en lugar de lo que falló. */
  fallback: (error: Error, retry: () => void) => ReactNode;
  children: ReactNode;
  /** Al cambiar, se vuelve a intentar pintar (p. ej. el `seq` de una sesión). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Un dato inesperado no puede dejar la ventana en blanco: lo que falla al
 * pintarse se sustituye por un aviso, y el resto de Dot sigue.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('dot: render failed', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}
