// PartBoundary (PLAN-26 T-113, region C): one per screen of the AI column that used to be its own
// React root (chips, work view, request queue, question cards). A render error empties only that
// container, as an uncaught error in the old root did, and the next redraw (a new `reset` value)
// renders it again, as the old root's next `render()` did. The error goes to the console.
import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { name: string; reset: unknown; children: ReactNode };
type State = { failed: boolean };

export class PartBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`화면 영역 오류(${this.props.name})`, error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.reset !== this.props.reset) this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
