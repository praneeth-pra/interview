// The free days and times: loaded from /api/days and /api/slots, cached per day and length.
import { ignoreQuery, render, state } from "./app";
import type { Day } from "./types";

// each day's free times by "date:length", and the requests for them in flight
let slotCache: Record<string, number[]> = {};
let slotRequests: Record<string, Promise<number[] | null>> = {};

export function loadDays(keepView?: boolean) {
  const duration = state.dur;
  return fetch("/api/days?duration=" + duration + ignoreQuery)
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      state.days = data.days;
      state.openSet = {};
      data.days.forEach(function (day: Day) {
        if (day.open) {
          state.openSet[day.key] = 1;
        }
        // The days list carries each day's times, so tapping a date needs no further request.
        if (day.slots) {
          const key = day.key + ":" + duration;
          slotCache[key] = day.slots;
          slotRequests[key] = Promise.resolve(day.slots);
        }
      });
      if (!keepView || !state.viewY) {
        const first =
          data.days.filter(function (day: Day) {
            return day.open;
          })[0] || data.days[0];
        if (first) {
          state.viewY = +first.key.slice(0, 4);
          state.viewM = +first.key.slice(5, 7);
        }
      }
      if (state.date && !state.openSet[state.date]) {
        state.date = null;
        state.slots = null;
        state.slot = null;
      }
      render();
      prefetchSlots();
    })
    .catch(function () {
      state.err = "Couldn't load available dates. Refresh the page to try again.";
      render();
    });
}
export function fetchSlots(date: string, duration: number, refresh?: boolean): Promise<number[] | null> {
  const key = date + ":" + duration;
  if (refresh || !slotRequests[key]) {
    slotRequests[key] = fetch("/api/slots?date=" + date + "&duration=" + duration + ignoreQuery)
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        slotCache[key] = data.slots || [];
        return slotCache[key];
      })
      .catch(function () {
        delete slotRequests[key];
        return null;
      });
  }
  return slotRequests[key];
}
// Load every open day's times in the background, two at a time, so tapping a date shows its times at once.
export function prefetchSlots() {
  const duration = state.dur;
  const queue = state.days
    .filter(function (day) {
      return day.open && !slotCache[day.key + ":" + duration];
    })
    .map(function (day) {
      return day.key;
    });
  function next() {
    const key = queue.shift();
    if (key && duration === state.dur) {
      fetchSlots(key, duration).then(next);
    }
  }
  next();
  next();
}
export function scrollToTimes() {
  if (window.innerWidth <= 900) {
    const heading = document.getElementById("timesh");
    if (heading) {
      heading.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }
}
export function showSlots(scroll?: boolean) {
  const key = state.date + ":" + state.dur;
  const cached = !!slotCache[key];
  state.slot = null;
  // Keep the previous day's times on screen (inactive) until this day's arrive, instead of flashing a spinner.
  state.stale = !cached && !!state.slots && state.slots.length > 0;
  state.slots = slotCache[key] || (state.stale ? state.slots : null);
  render();
  if (cached && scroll) {
    scrollToTimes();
  }
  fetchSlots(state.date!, state.dur, cached).then(function (slots) {
    if (key === state.date + ":" + state.dur) {
      if (!slots) {
        if (!state.slots || state.stale) {
          state.stale = false;
          state.slots = [];
          render();
        }
        return;
      }
      if (!state.slots || state.stale) {
        state.stale = false;
        state.slots = slots;
        render();
        if (scroll) {
          scrollToTimes();
        }
        return;
      }
      if (slots.join() !== state.slots.join()) {
        state.slots = slots;
        if (state.slot && slots.indexOf(state.slot) < 0) {
          state.slot = null;
        }
        render();
      }
    }
  });
}
// Forget every day's times, after a booking changes them.
export function clearSlots() {
  slotCache = {};
  slotRequests = {};
}
