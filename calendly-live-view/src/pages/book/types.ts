// Shapes shared by the booking page's modules.
export type Step = "pick" | "details" | "confirm" | "done" | "manage" | "cancel" | "msg";
export type Day = { key: string; open: boolean; slots?: number[] };
export type Booking = {
  id: string;
  name: string;
  email: string;
  start: string;
  end: string;
  duration: number;
  company?: string;
  round?: string;
  manage?: string;
  emailed?: boolean;
};
// Set when the page is opened from a manage link; `error` when the link is invalid.
export type Manage = {
  id: string;
  t: string;
  name: string;
  email: string;
  start: string;
  end: string;
  duration: number;
  cancelled: boolean;
  past: boolean;
  error?: string;
};
export type Message = { title: string; body: string; check?: boolean; again?: boolean; manage?: boolean };
export type FieldOptions = { req?: boolean; ac?: string; max?: number; list?: string; ph?: string };
export type State = {
  dur: number; // meeting length in minutes
  days: Day[];
  openSet: Record<string, 1>; // days with free times
  viewY: number; // month shown in the calendar
  viewM: number;
  date: string | null; // chosen day, "YYYY-MM-DD"
  slots: number[] | null; // free start times on that day (ms); null while loading
  slot: number | null; // chosen start time
  step: Step;
  booking: Booking | null; // the booking just made
  err: string;
  fieldErr: Record<string, string>;
  form: { name: string; email: string; company: string; round: string };
  invite?: File | null; // the interview invite chosen on the details step (not kept in the draft)
  inviteHr?: boolean; // the candidate ticked that the HR's details show in the invite
  admin?: boolean; // a signed-in admin is booking: a demo goes through the admin API
  busy: boolean;
  anim?: boolean; // slide the times list in on the next render
  stale?: boolean; // the times shown are the previous day's, kept on screen until the new day's arrive
  nameAuto?: boolean; // the name was filled in from an earlier booking
  reason?: string; // cancellation reason being typed
  msg?: Message | null;
};
// The companies this browser booked before, so a candidate's next round uses the same company name as the last
// one. Kept only on the candidate's own device (never looked up by email), so nobody can see where someone else
// is interviewing.
export type Me = { email: string; name: string; companies: string[] };
