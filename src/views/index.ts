/**
 * Views 도메인 barrel.
 *
 * 사이드바 트리·webview 컴포넌트들의 단일 entry. extension.ts wrapper 에서
 * `import { TaskTreeProvider, ApprovalsPanelProvider, ... } from './views'` 형태로
 * 사용. office-panel, company-dashboard 는 자체 import 경로가 이미 있어 여기서는
 * 새로 추출한 5개 파일만 묶는다.
 */

export { TaskTreeItem, TaskTreeProvider } from './tasks-tree';
export { ApprovalsPanelProvider } from './approvals-panel';
export { YouTubeDashboardProvider } from './youtube-dashboard';
export { ApiConnectionsPanel } from './api-connections-panel';
export { RevenueDashboardPanel } from './revenue-dashboard';
export { CompanyDashboardPanel } from './company-dashboard';
export { OfficePanel } from './office-panel';
