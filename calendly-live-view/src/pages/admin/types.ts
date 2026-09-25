// Shapes of what the admin API and /admin/stream send.
export type Booking = {
  id: string;
  name: string;
  email: string;
  company?: string;
  round?: string;
  start: string;
  end: string;
  duration: number;
  createdAt: string;
  source?: "admin" | "calendly" | string;
  cancelled?: boolean;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  rescheduledAt?: string;
  rescheduledBy?: string;
  prevStart?: string;
};
// A cancellation or reschedule in the last 30 days.
export type Change = Booking & { kind: "cancelled" | "rescheduled"; at: string };
export type State = {
  ready: boolean;
  build?: string; // the server's deploy; see checkForUpdate() in main.ts
  events: Booking[];
  changes: Change[];
  iv: { names: string[]; assign: Record<string, string> };
  allow: { enabled: boolean; count: number };
  hours: { start: number; end: number };
  email: boolean;
};
export type Allowlist = { enabled: boolean; emails: string[] };

declare global {
  interface Window {
    __openB?: (id: string) => void;
    __stats?: () => void;
  }
  interface Navigator {
    standalone?: boolean;
  }
}
