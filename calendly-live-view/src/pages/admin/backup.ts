// Backup (⋯ menu, owners only): download all the data now, or restore it from backup files (the weekly backup email's
// backup.json, or its parts when the files were split over several emails, or a download). Restoring sends the data
// first, then each resume and receipt on its own, so no request is bigger than one upload.
import { el, setMessage, toast } from "./dom";
import { request } from "./api";
import { openPanel, panel } from "./panel";

type Backup = {
  app?: string;
  version?: number;
  createdAt?: string;
  part?: number;
  parts?: number;
  files?: Record<string, any>;
  uploads?: Record<string, string>;
};

export function showBackup() {
  panel.refresh = null;
  const body = openPanel("Backup", "A full backup is emailed to you every week. Keep those emails.");
  const msg = el("p", { class: "msg", role: "status" });
  const input = el("input", { type: "file", id: "bkFile", accept: ".json,application/json", multiple: true }) as HTMLInputElement;
  const summary = el("p", { class: "bksum", hidden: "" });
  const go = el("button", { type: "button", class: "danger", text: "Replace all data with this backup", hidden: "" }) as HTMLButtonElement;
  let chosen: Backup | null = null;

  input.onchange = function () {
    chosen = null;
    summary.hidden = go.hidden = true;
    setMessage(msg, "");
    const picked = Array.prototype.slice.call(input.files || []) as File[];
    if (!picked.length) {
      return;
    }
    Promise.all(
      picked.map(function (file) {
        return file.text().then(
          function (text) {
            try {
              return JSON.parse(text) as Backup;
            } catch (e) {
              return null;
            }
          },
          function () {
            return null;
          },
        );
      }),
    ).then(function (all) {
      if (
        all.some(function (backup) {
          return !backup || backup.app !== "booking-form";
        })
      ) {
        return setMessage(msg, (picked.length > 1 ? "One of those files isn't" : "That file isn't") + " a backup from this site.", true);
      }
      const backups = all as Backup[];
      const main = backups.filter(function (backup) {
        return backup.files && backup.files["bookings.json"];
      });
      if (main.length !== 1) {
        return setMessage(
          msg,
          main.length ? "Choose the files from one backup only." : "Choose the backup file with the data too (the first email's, part 1).",
          true,
        );
      }
      const data = main[0]!;
      if (
        backups.some(function (backup) {
          return backup.createdAt !== data.createdAt;
        })
      ) {
        return setMessage(msg, "Those files are from different backups. Choose the files from one email date.", true);
      }
      const uploads: Record<string, string> = {};
      backups.forEach(function (backup) {
        Object.assign(uploads, backup.uploads || {});
      });
      chosen = { ...data, uploads: uploads };
      const files = data.files!;
      const count = function (name: string, key: string) {
        return ((files[name] && files[name][key]) || []).length;
      };
      const partsWanted = data.parts || 1;
      const partsHave = new Set(
        backups.map(function (backup) {
          return backup.part || 1;
        }),
      ).size;
      const when = data.createdAt ? new Date(data.createdAt) : null;
      summary.textContent =
        "Backup from " +
        (when && !isNaN(+when) ? when.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "an unknown date") +
        ": " +
        count("bookings.json", "bookings") +
        " bookings, " +
        count("enquiries.json", "enquiries") +
        " enquiries, " +
        count("payments.json", "payments") +
        " payments and " +
        Object.keys(uploads).length +
        " resumes and receipts." +
        (partsHave < partsWanted
          ? " This backup came in " +
            partsWanted +
            " emails and you chose " +
            partsHave +
            " of its files, so some resumes and receipts would be missing. Choose all " +
            partsWanted +
            " together if you can."
          : "") +
        " Everything on the site now is replaced by this.";
      summary.hidden = go.hidden = false;
    });
  };

  go.onclick = function () {
    const backup = chosen;
    if (!backup) {
      return;
    }
    go.disabled = input.disabled = true;
    setMessage(msg, "Restoring the data…");
    const uploads = Object.entries(backup.uploads || {});
    let done = 0;
    let failed = 0;
    // one file at a time, so a slow phone connection doesn't send them all at once
    const next = function (): Promise<void> {
      const item = uploads[done + failed];
      if (!item) {
        return Promise.resolve();
      }
      setMessage(msg, "Restoring resumes and receipts: " + (done + failed + 1) + " of " + uploads.length + "…");
      const bytes = Uint8Array.from(atob(item[1]), function (c) {
        return c.charCodeAt(0);
      });
      return fetch("/admin/api/restore-file?path=" + encodeURIComponent(item[0]), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      })
        .then(
          function (response) {
            response.ok ? done++ : failed++;
          },
          function () {
            failed++;
          },
        )
        .then(next);
    };
    request<{ bookings: number }>("/admin/api/restore", {
      app: backup.app,
      version: backup.version,
      createdAt: backup.createdAt,
      files: backup.files,
    })
      .then(function (result) {
        return next().then(function () {
          toast("Backup restored");
          setMessage(
            msg,
            "Restored " +
              result.bookings +
              " bookings" +
              (uploads.length ? " and " + done + " of " + uploads.length + " resumes and receipts" : "") +
              "." +
              (failed
                ? " Choose the file again to retry the ones that didn't go through."
                : " Browser alerts need turning on again on each device."),
            failed > 0,
          );
          summary.hidden = go.hidden = true;
        });
      })
      .catch(function (error) {
        setMessage(msg, error.message, true);
      })
      .then(function () {
        go.disabled = input.disabled = false;
        input.value = "";
      });
  };

  body.appendChild(
    el("div", { class: "bkview" }, [
      el("a", { class: "pri bkdl", href: "/admin/backup.json", download: "", text: "Download a backup now" }),
      el("h3", { class: "unh", text: "Restore" }),
      el("p", {
        class: "sub",
        text: "If the site's data is ever lost, choose the backup.json file from the latest backup email (all its parts, if it came in several emails). It puts back the bookings, enquiries, payments, resumes, receipts and settings.",
      }),
      el("div", { class: "f" }, [el("label", { for: "bkFile", text: "Backup files" }), input]),
      summary,
      go,
      msg,
    ]),
  );
}
