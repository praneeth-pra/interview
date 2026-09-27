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
  missed?: "noshow" | "other" | ""; // marked after the start time when the interview didn't take place
  missedAt?: string;
  outcome?: "cleared" | "rejected" | "hold" | ""; // the round's result; none means Scheduled
  outcomeAt?: string;
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
  owner?: boolean; // owners see Enquiries and Payments; the admins they add don't
  enquiries?: string[]; // when each enquiry came in (owners only)
  payments?: number; // how many payments there are (owners only)
  paymentsPending?: number; // how many are waiting to be confirmed or discarded (owners only)
  hours: { start: number; end: number };
  email: boolean;
};
export type Allowlist = { enabled: boolean; emails: string[] };

declare global {
  interface Window {
    __openB?: (id: string) => void;
    __stats?: () => void;
    __enq?: () => void; // the Enquiries tab was opened
    __pay?: () => void; // the Payments tab was opened
    __rev?: () => void; // the Analytics tab was opened
    __statsEvent?: string; // open this booking's candidate when the Contacts tab shows
  }
  interface Navigator {
    standalone?: boolean;
  }
}
