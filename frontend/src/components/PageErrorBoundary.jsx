import React from "react";
import { C } from "../lib/theme";

/* Without this, any exception while rendering a page unmounts the whole
   app and the user sees a black screen. Now the sidebar/header stay and
   only the page area shows the error. `resetKey` (the current view)
   clears the error when the user navigates elsewhere. */
export default class PageErrorBoundary extends React.Component {
  state = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error("[PageErrorBoundary]", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-6 rounded-2xl" style={{ background: C.redSoft }}>
        <div className="text-sm font-semibold" style={{ color: C.red }}>Ocorreu um erro ao mostrar esta página. / Something went wrong showing this page.</div>
        <div className="text-xs mt-2 break-words" style={{ color: C.textSecondary }}>{String(this.state.error?.message || this.state.error)}</div>
        <button onClick={() => this.setState({ error: null })} className="mt-4 px-4 py-2 rounded-xl text-sm font-medium text-white" style={{ background: C.blue }}>
          Tentar de novo / Retry
        </button>
      </div>
    );
  }
}
