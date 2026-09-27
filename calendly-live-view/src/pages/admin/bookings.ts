// Every booking, cancelled and past ones too, as the admin API lists them; and finding one by id.
import { request } from "./api";
import { state } from "./state";
import type { Booking } from "./types";

// every booking, for search and the booking panel; fetched when needed and again after 30s
export let allBookings: Booking[] | null = null;
let allBookingsAt = 0;
export function findBooking(id: string) {
  function find(list: Booking[] | null) {
    return (list || []).filter(function (booking) {
      return booking.id === id;
    })[0];
  }
  return find(state.events) || find(state.changes) || find(allBookings);
}
export function loadAllBookings() {
  if (allBookings && Date.now() - allBookingsAt < 30000) {
    return Promise.resolve(allBookings);
  } else {
    return request("/admin/api/bookings").then(function (result) {
      allBookings = result.bookings;
      allBookingsAt = Date.now();
      return allBookings;
    });
  }
}
// The live state changed: the next search fetches every booking again.
export function forgetAllBookings() {
  allBookingsAt = 0;
}
