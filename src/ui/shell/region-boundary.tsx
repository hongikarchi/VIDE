// RegionBoundary (PLAN-26 T-113, ARCH-01 「웹 화면 구조」): one per shell region, so a render error
// in one region removes only that region's markup instead of unmounting the whole shell root (and
// with it #canvas, the composer and the other regions). Before T-113 only the mobile tab bar was a
// React root, and its failure emptied #mobile-navigation alone; the boundary inside
// MobileNavigationShell keeps exactly that. The fallback is empty; the error goes to the console.
import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { name: string; children: ReactNode };
type State = { failed: boolean };

export class RegionBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`화면 영역 오류(${this.props.name})`, error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
