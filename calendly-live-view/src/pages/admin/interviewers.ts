// Interview supporters (⋯ menu): the names an admin can record against a started interview, renamed or reordered here.
import { el, setMessage, toast } from "./dom";
import { request } from "./api";
import { colorClass, state } from "./state";
import { closePanel, openPanel, panel } from "./panel";

export function showInterviewers() {
  panel.refresh = null;
  var body = openPanel("Interview supporters", "Rename, add or remove. Renaming also updates interviews already recorded.");
  var rows = el("div");
  var msg = el("p", {
    class: "msg",
    role: "status",
  });
  var list = state.iv.names.map(function (name) {
    return {
      from: name,
      to: name,
    };
  });
  function renderRows() {
    rows.textContent = "";
    list.forEach(function (entry, index) {
      var input = el("input", {
        type: "text",
        maxlength: "30",
        "aria-label": "Interview supporter " + (index + 1) + " name",
      });
      input.value = entry.to;
      input.oninput = function () {
        entry.to = input.value;
      };
      rows.appendChild(
        el(
          "div",
          {
            class: "ivrow",
          },
          [
            el("span", {
              class: "lg " + (entry.from ? colorClass(entry.from) : "cn"),
            }),
            input,
            el("button", {
              type: "button",
              class: "rm",
              text: "Remove",
              "aria-label": "Remove " + (entry.to || "interview supporter"),
              onclick: function () {
                list.splice(index, 1);
                renderRows();
              },
            }),
          ],
        ),
      );
    });
  }
  renderRows();
  body.appendChild(rows);
  body.appendChild(
    el("button", {
      type: "button",
      class: "linkbtn",
      text: "+ Add interview supporter",
      onclick: function () {
        if (list.length >= 12) {
          return setMessage(msg, "You can have up to 12 interview supporters.", true);
        }
        list.push({
          from: "",
          to: "",
        });
        renderRows();
        (rows.lastChild as HTMLElement).querySelector("input")!.focus();
      },
    }),
  );
  var saveButton = el("button", {
    type: "button",
    class: "pri",
    text: "Save",
    onclick: function () {
      saveButton.disabled = true;
      request("/admin/api/interviewer-names", {
        list: list,
      })
        .then(function () {
          closePanel();
          toast("Interview supporters saved");
        })
        .catch(function (error) {
          saveButton.disabled = false;
          setMessage(msg, error.message, true);
        });
    },
  });
  body.appendChild(
    el(
      "div",
      {
        class: "row mt",
      },
      [
        saveButton,
        el("button", {
          type: "button",
          class: "ghost",
          text: "Cancel",
          onclick: closePanel,
        }),
      ],
    ),
  );
  body.appendChild(msg);
}
