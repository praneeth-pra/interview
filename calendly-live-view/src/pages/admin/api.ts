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
        location.reload();
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

export { request };
