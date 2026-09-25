document.getElementById("f").addEventListener("submit", function (event) {
  event.preventDefault();
  var button = document.getElementById("go");
  var errorBox = document.getElementById("err");
  button.disabled = true;
  button.textContent = "Signing in…";
  errorBox.textContent = "";
  fetch("/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password: document.getElementById("pw").value,
    }),
  })
    .then(function (response) {
      return response.json().then(function (body) {
        return {
          ok: response.ok,
          j: body,
        };
      });
    })
    .then(function (result) {
      if (result.ok) {
        return location.reload();
      }
      button.disabled = false;
      button.textContent = "Sign in";
      errorBox.textContent = result.j.error || "Couldn't sign in.";
    })
    .catch(function () {
      button.disabled = false;
      button.textContent = "Sign in";
      errorBox.textContent = "Couldn't reach the server. Check your connection and try again.";
    });
});
