// Searching candidates from the calendar's search box.
import { byId, el } from "./dom";
import { formatRange } from "./time";
import { statusOf, titleCase } from "./labels";
import type { Booking } from "./types";
import { loadAllBookings } from "./bookings";
import { showBooking, showWeekOf } from "./booking-panel";

// The candidate search box: every booking by name, email or company, with keyboard navigation.
export function setupSearch() {
  var searchBox = byId<HTMLInputElement>("q");
  var searchList = byId("qdrop");
  var matches: Booking[] = [];
  var activeIndex = -1;
  function closeSearch() {
    searchList.hidden = true;
    searchBox.setAttribute("aria-expanded", "false");
    searchBox.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  }
  function highlight(index: number) {
    activeIndex = index;
    for (var i = 0; i < searchList.children.length; i++) {
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
    var booking = matches[index];
    if (booking) {
      closeSearch();
      showWeekOf(booking);
      showBooking(booking.id);
    }
  }
  searchBox.addEventListener("input", function () {
    var query = searchBox.value.trim().toLowerCase();
    if (query.length < 2) {
      return closeSearch();
    }
    loadAllBookings()
      .then(function (bookings) {
        if (searchBox.value.trim().toLowerCase() === query) {
          matches = bookings!
            .filter(function (booking) {
              return (booking.name + " " + booking.email + " " + booking.company).toLowerCase().indexOf(query) >= 0;
            })
            .slice(0, 8);
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
          matches.forEach(function (booking, index) {
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
                    text: formatRange(booking) + " · " + statusOf(booking),
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
