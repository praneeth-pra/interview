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
  outcomeBy?: "next-round" | ""; // "next-round": set to Cleared when the candidate booked their next round
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
// What the Candidates list API answers; adding also says how many were added, already there, or not emails.
export type AllowAnswer = { state: Allowlist; added?: number; existing?: number; invalid?: string[] };
export type AllowAdded = AllowAnswer & { added: number; existing: number; invalid: string[] };
// Who can sign in (/admin/api/admins): the owners from ADMIN_EMAILS, the admins they added, and who is asking.
export type AdminsView = { owners: string[]; emails: string[]; me: string };
// Browser alerts (/admin/api/push): the server's key, every device's endpoint, and this admin's own devices.
export type PushInfo = { key: string; endpoints: string[]; yours?: string[] };
// A payment as /admin/api/payments sends it (paymentView() in src/server/payments.ts); "" where not set.
export type Payment = {
  id: string;
  name: string;
  email: string;
  amount: number;
  installment: "" | "advance" | "1" | "final" | "2" | "3";
  check: "" | "verified" | "unread";
  decision: "" | "confirmed" | "discarded";
  decidedAt: string;
  createdAt: string;
  receipt: { name: string; type: string; size: number };
};
// An enquiry as /admin/api/enquiries sends it (enquiryView() in src/server/enquiries.ts).
export type Enquiry = {
  id: string;
  name: string;
  email: string;
  phone: string;
  tech: string;
  experience: string;
  createdAt: string;
  resume: { name: string; size: number };
};

declare global {
  interface Window {
    __openB?: (id: string) => void;
    __stats?: () => void;
    __enq?: () => void; // the Enquiries tab was opened
    __pay?: () => void; // the Payments tab was opened
    __rev?: () => void; // the Revenue tab was opened
    __statsEvent?: string; // open this booking's candidate when the Contacts tab shows
    __contact?: (open: boolean) => void; // Contacts opened a person (true) or went back to its list (false)
    __contactBack?: () => void; // in the Contacts frame: show the list again
    __contactRefresh?: () => Promise<unknown>; // in the Contacts frame: fetch the list and open person again
    __theme?: (theme: string) => void; // theme.ts: switch to "light" or "dark" ("" follows the phone)
    __contactSearch?: () => boolean; // in the Contacts frame: show or hide its search field; true when shown
  }
  interface Navigator {
    standalone?: boolean;
    deviceMemory?: number; // Chrome: the phone's memory in GB
    connection?: { saveData?: boolean }; // Chrome: Data Saver
  }
}
