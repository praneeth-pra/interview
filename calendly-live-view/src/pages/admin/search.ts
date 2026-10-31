// Searching candidates from the calendar's search box.
import { byId, el } from "./dom";
import { titleCase } from "./labels";
import { candidateMatches, type CandidateMatch } from "./candidates";
import { loadAllBookings } from "./bookings";

// The candidate search box: each candidate once, by name, email or company, with keyboard navigation.
export function setupSearch() {
  const searchBox = byId<HTMLInputElement>("q");
  const searchList = byId("qdrop");
  let matches: CandidateMatch[] = [];
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
                    text: [match.email, match.count + (match.count === 1 ? " booking" : " bookings")].filter(Boolean).join(" · "),
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
