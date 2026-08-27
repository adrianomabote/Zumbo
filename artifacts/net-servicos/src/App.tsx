import { useEffect, useRef, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function App() {
  const storefrontRef = useRef<HTMLIFrameElement>(null);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [installVisible, setInstallVisible] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const installDismissKey = "pwa-install-notice-dismissed-v2";

  useEffect(() => {
    // The legacy admin panel is served by the API bridge. Redirect friendly
    // public URLs before the storefront iframe is mounted over them.
    if (window.location.pathname.startsWith("/admin")) {
      const target = `/api/legacy${window.location.pathname}${window.location.search}`;
      window.location.replace(target);
    }

    const isStandalone = () => {
      const displayMode = window.matchMedia?.("(display-mode: standalone)");
      return (
        displayMode?.matches === true ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      );
    };
    const showInstallNotice = () => {
      if (!isStandalone() && !sessionStorage.getItem(installDismissKey)) {
        setInstallVisible(true);
      }
    };

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredPromptRef.current = event as BeforeInstallPromptEvent;
      setInstallHelp(false);
      showInstallNotice();
    };

    const onAppInstalled = () => {
      deferredPromptRef.current = null;
      setInstallVisible(false);
    };

    const serviceWorkerUrl = new URL(
      `${import.meta.env.BASE_URL}sw.js`,
      window.location.href,
    );
    const serviceWorkerScope = new URL(import.meta.env.BASE_URL, window.location.href);

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    const noticeTimer = window.setTimeout(showInstallNotice, 700);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register(serviceWorkerUrl, { scope: serviceWorkerScope.pathname })
        .catch(() => {});
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.clearTimeout(noticeTimer);
    };
  }, []);

  const installApp = async () => {
    const prompt = deferredPromptRef.current;
    if (!prompt) {
      setInstallHelp(true);
      setInstallVisible(true);
      return;
    }

    deferredPromptRef.current = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstallVisible(false);
      } else {
        setInstallVisible(false);
      }
    } catch {
      setInstallHelp(true);
      setInstallVisible(true);
    }
  };

  const dismissInstallNotice = () => {
    sessionStorage.setItem(installDismissKey, "1");
    setInstallVisible(false);
  };

  if (window.location.pathname.startsWith("/admin")) {
    return null;
  }

  return (
    <>
      <iframe
        title="Loja Megabyte — comprar pacotes de internet Vodacom"
        ref={storefrontRef}
        src={`${import.meta.env.BASE_URL}api/legacy/megas`}
        style={{
          border: 0,
          display: "block",
          height: "100vh",
          width: "100vw",
        }}
      />
      {installVisible && (
        <div className="pwa-install-notice" role="region" aria-label="Instalar aplicação Megabyte">
          <div className="pwa-install-notice-icon" aria-hidden="true">M</div>
          <div className="pwa-install-notice-copy">
            <strong>Instala a app Megabyte</strong>
            <span>
              {installHelp
                ? "Abre o menu ⋮ e escolhe “Instalar app”"
                : "Compra megas e paga com facilidade no teu telemóvel"}
            </span>
          </div>
          <button type="button" className="pwa-install-notice-button" onClick={() => void installApp()}>
            Instalar
          </button>
          <button
            type="button"
            className="pwa-install-notice-close"
            onClick={dismissInstallNotice}
            aria-label="Fechar aviso de instalação"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

export default App;
