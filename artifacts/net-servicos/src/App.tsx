import { useEffect, useRef } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function App() {
  const storefrontRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // The legacy admin panel is served by the API bridge. Redirect friendly
    // public URLs before the storefront iframe is mounted over them.
    if (window.location.pathname.startsWith("/admin")) {
      const target = `/api/legacy${window.location.pathname}${window.location.search}`;
      window.location.replace(target);
    }

    let deferredPrompt: BeforeInstallPromptEvent | null = null;
    const postToStorefront = (message: Record<string, string>) => {
      storefrontRef.current?.contentWindow?.postMessage(message, window.location.origin);
    };

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredPrompt = event as BeforeInstallPromptEvent;
      postToStorefront({ type: "pwa-install-available" });
    };

    const onStorefrontMessage = async (event: MessageEvent) => {
      const storefrontWindow = storefrontRef.current?.contentWindow;
      if (
        event.origin !== window.location.origin ||
        (storefrontWindow && event.source !== storefrontWindow)
      ) {
        return;
      }

      if (event.data?.type !== "pwa-install-request") return;
      if (!deferredPrompt) {
        postToStorefront({ type: "pwa-install-unavailable" });
        return;
      }

      const prompt = deferredPrompt;
      deferredPrompt = null;
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        postToStorefront({ type: "pwa-install-result", outcome: choice.outcome });
      } catch {
        postToStorefront({ type: "pwa-install-result", outcome: "dismissed" });
      }
    };

    const onAppInstalled = () => {
      deferredPrompt = null;
      postToStorefront({ type: "pwa-installed" });
    };

    const storefrontLoaded = () => {
      if (deferredPrompt) postToStorefront({ type: "pwa-install-available" });
    };

    const serviceWorkerUrl = new URL(
      `${import.meta.env.BASE_URL}sw.js`,
      window.location.href,
    );
    const serviceWorkerScope = new URL(import.meta.env.BASE_URL, window.location.href);

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("message", onStorefrontMessage);
    window.addEventListener("appinstalled", onAppInstalled);
    storefrontRef.current?.addEventListener("load", storefrontLoaded);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register(serviceWorkerUrl, { scope: serviceWorkerScope.pathname })
        .catch(() => {});
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("message", onStorefrontMessage);
      window.removeEventListener("appinstalled", onAppInstalled);
      storefrontRef.current?.removeEventListener("load", storefrontLoaded);
    };
  }, []);

  if (window.location.pathname.startsWith("/admin")) {
    return null;
  }

  return (
    <iframe
      title="Megabyte"
      ref={storefrontRef}
      src={`${import.meta.env.BASE_URL}api/legacy/megas`}
      style={{
        border: 0,
        display: "block",
        height: "100vh",
        width: "100vw",
      }}
    />
  );
}

export default App;
