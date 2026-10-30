// Searching candidates from the calendar's search box.
import { byId, el } from "./dom";
import { titleCase } from "./labels";
import type { Booking } from "./types";
import { loadAllBookings } from "./bookings";

// One row per candidate (by email): their latest booking, which opens them in Contacts, and how many they have.
export function candidateMatches(bookings: Booking[], query: string, limit: number) {
  const people = new Map<string, { booking: Booking; count: number }>();
  bookings.forEach(function (booking) {
    if ((booking.name + " " + booking.email + " " + booking.company).toLowerCase().indexOf(query) < 0) {
      return;
    }
    const key = (booking.email || booking.name).trim().toLowerCase();
    const seen = people.get(key);
    if (!seen) {
      people.set(key, { booking: booking, count: 1 });
    } else {
      seen.count++;
      if (booking.start > seen.booking.start) {
        seen.booking = booking;
      }
    }
  });
  return Array.from(people.values()).slice(0, limit);
}

// The candidate search box: each candidate once, by name, email or company, with keyboard navigation.
export function setupSearch() {
  const searchBox = byId<HTMLInputElement>("q");
  const searchList = byId("qdrop");
  let matches: { booking: Booking; count: number }[] = [];
  let activeIndex = -1;
  function closeSearch() {
    searchList.hidden = true;
    searchBox.setAttribute("aria-expanded", "false");
    searchBox.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  }
  function highlight(index: number) {
    activeIndex = index;
    for (let i = 0; i < searchList.children.length; i++) {
      searchList.children[i].setAttribute("aria-selected", String(i === index));
    }
    if (index >= 0) {
      searchBox.setAttribute("aria-activedescendant", "qo" + index);
      searchList.children[index].scrollIntoView({
        block: "nearest",
      });
    }
  }
  function choose(index: number) {
    const match = matches[index];
    if (match) {
      closeSearch();
      searchBox.value = "";
      searchBox.blur();
      window.__openContact?.(match.booking.id);
    }
  }
  searchBox.addEventListener("input", function () {
    const query = searchBox.value.trim().toLowerCase();
    if (query.length < 2) {
      return closeSearch();
    }
    loadAllBookings()
      .then(function (bookings) {
        if (searchBox.value.trim().toLowerCase() === query) {
          matches = candidateMatches(bookings!, query, 8);
          searchList.textContent = "";
          activeIndex = -1;
          if (!matches.length) {
            searchList.appendChild(
              el("li", {
                class: "m",
                text: "No matching candidates",
              }),
            );
          }
          matches.forEach(function (match, index) {
            const booking = match.booking;
            searchList.appendChild(
              el(
                "li",
                {
                  id: "qo" + index,
                  role: "option",
                  "aria-selected": "false",
                  onmousedown: function (event: MouseEvent) {
                    event.preventDefault();
                  },
                  onclick: function () {
                    choose(index);
                  },
                },
                [
                  el("b", {
                    text: titleCase(booking.name),
                  }),
                  el("div", {
                    class: "m",
                    text: [booking.email, match.count + (match.count === 1 ? " booking" : " bookings")].filter(Boolean).join(" · "),
                  }),
                ],
              ),
            );
          });
          searchList.hidden = false;
          searchBox.setAttribute("aria-expanded", "true");
        }
      })
      .catch(function () {});
  });
  searchBox.addEventListener("keydown", function (event) {
    if (!searchList.hidden) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        highlight(activeIndex < matches.length - 1 ? activeIndex + 1 : 0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        highlight(activeIndex > 0 ? activeIndex - 1 : matches.length - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        choose(activeIndex < 0 ? 0 : activeIndex);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    }
  });
  searchBox.addEventListener("blur", closeSearch);
}
