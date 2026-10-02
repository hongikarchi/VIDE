// RegionBoundary (PLAN-26 T-113, ARCH-01 「웹 화면 구조」): one per shell region, so a render error
// in one region removes only that region's markup instead of unmounting the whole shell root (and
// with it #canvas, the composer and the other regions). Before T-113 only the mobile tab bar was a
// React root, and its failure emptied #mobile-navigation alone; the boundary inside
// MobileNavigationShell keeps exactly that. The fallback is empty; the error goes to the console.
// As an old root's next `render()` drew its container again, a failed region draws again after the
// next state change of any slice (`subscribeAnySlice`); the data-driven parts inside a region sit
// in their own PartBoundary so the region's ids stay for the imperative code meanwhile.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { subscribeAnySlice } from '../store/core.ts';

type Props = { name: string; children: ReactNode };
type State = { failed: boolean };

export class RegionBoundary extends Component<Props, State> {
  override state: State = { failed: false };
  private unsubscribe: (() => void) | undefined;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`화면 영역 오류(${this.props.name})`, error, info.componentStack);
  }

  override componentDidUpdate(): void {
    if (!this.state.failed || this.unsubscribe) return;
    this.unsubscribe = subscribeAnySlice(() => {
      this.stopRetry();
      this.setState({ failed: false });
    });
  }

  override componentWillUnmount(): void {
    this.stopRetry();
  }

  private stopRetry(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
