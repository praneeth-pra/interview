// JSON requests to the admin API. A 401 reloads the page, which shows the sign-in form.
function request(url: string, body?: unknown, method?: string): Promise<any> {
  return fetch(
    url,
    body === undefined
      ? {}
      : {
          method: method || "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
  ).then(
    function (response) {
      if (response.status === 401) {
        freshReload();
        throw new Error("Sign in again.");
      }
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (result) {
          if (!response.ok) {
            throw new Error(result.error || "Something went wrong. Try again.");
          }
          return result;
        });
    },
    function () {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    },
  );
}

// The home-screen app opens from a saved copy of the page (see sw.js). Reloading after signing out, or to pick up a
// deploy, drops that copy first so the reload comes from the server.
function freshReload() {
  var done = function () {
    location.reload();
  };
  if (window.caches) {
    caches.delete("admin-shell-v1").then(done, done);
  } else {
    done();
  }
}

export { request, freshReload };
