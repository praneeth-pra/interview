document.getElementById("f").addEventListener("submit", function (o) {
  o.preventDefault();
  var t = document.getElementById("go"),
    e = document.getElementById("err");
  ((t.disabled = !0),
    (t.textContent = "Signing in…"),
    (e.textContent = ""),
    fetch("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("pw").value }),
    })
      .then(function (n) {
        return n.json().then(function (i) {
          return { ok: n.ok, j: i };
        });
      })
      .then(function (n) {
        if (n.ok) return location.reload();
        ((t.disabled = !1), (t.textContent = "Sign in"), (e.textContent = n.j.error || "Couldn't sign in."));
      })
      .catch(function () {
        ((t.disabled = !1),
          (t.textContent = "Sign in"),
          (e.textContent = "Couldn't reach the server. Check your connection and try again."));
      }));
});
