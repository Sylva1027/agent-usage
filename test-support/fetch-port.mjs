// OS-assigned ephemeral ports can be forbidden by fetch; callers own server cleanup.
export async function listenOnFetchPort(server) {
  for (let attempt = 0; ; attempt += 1) {
    let onError;
    let onListening;
    try {
      await new Promise((resolve, reject) => {
        onError = reject;
        onListening = resolve;
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(20_000 + Math.floor(Math.random() * 10_000), "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || attempt >= 20) throw error;
    } finally {
      server.off("error", onError);
      server.off("listening", onListening);
    }
  }
}
