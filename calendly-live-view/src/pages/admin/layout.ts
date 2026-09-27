// Placing bookings side by side when they overlap, for the week grid and the agenda. No DOM, so it is unit-tested.
import type { Booking } from "./types";

// A booking placed on the week grid: minutes since midnight, and its column within a group of overlapping bookings.
export type Item = { booking: Booking; from: number; to: number; col?: number; group?: { end: number; cols: number[] } };
// Overlapping bookings share the column width: each gets a col index within its group.
export function layoutColumns(items: Item[]) {
  var group: Item["group"] | null = null;
  items.forEach(function (item) {
    if (!group || item.from >= group.end) {
      group = {
        end: item.to,
        cols: [],
      };
    }
    for (var col = 0; group.cols[col] !== undefined && group.cols[col] > item.from; ) {
      col++;
    }
    group.cols[col] = item.to;
    item.col = col;
    item.group = group;
    group.end = Math.max(group.end, item.to);
  });
}
