import { useEffect, useRef, useState } from "react";
import "./seo-page.css";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type SeoPage = {
  title: string;
  description: string;
  canonical: string;
  eyebrow: string;
  heading: string;
  lead: string;
  sectionHeading: string;
  paragraphs?: string[];
  items?: Array<{ heading: string; text: string }>;
  steps?: string[];
  cta: string;
};

const SEO_PAGES: Record<string, SeoPage> = {
  "/comprar-megas": {
    title: "Comprar Megas Vodacom em Moçambique | Megabyte",
    description:
      "Compre megas e pacotes de internet Vodacom em Moçambique na Megabyte. Escolha o pacote, indique o número e pague com M-Pesa ou e-Mola.",
    canonical: "https://megabyte.live/comprar-megas/",
    eyebrow: "Internet Vodacom",
    heading: "Comprar megas Vodacom em Moçambique",
    lead:
      "Escolha pacotes de internet para o seu número Vodacom ou envie megas para outra pessoa de forma simples.",
    sectionHeading: "Como comprar megas",
    steps: [
      "Abra a loja e escolha o pacote de internet disponível.",
      "Indique o número Vodacom que deve receber os megas.",
      "Pague com M-Pesa ou e-Mola e aguarde a activação do pacote.",
    ],
    cta: "Comprar agora",
  },
  "/pacotes-diarios": {
    title: "Pacotes Diários Vodacom a partir de 20 MT | Megabyte",
    description:
      "Veja os pacotes diários de internet Vodacom da Megabyte, a partir de 20 MT. Compre megas e pague com M-Pesa ou e-Mola.",
    canonical: "https://megabyte.live/pacotes-diarios/",
    eyebrow: "Pacotes Vodacom",
    heading: "Pacotes diários de internet Vodacom",
    lead:
      "Precisa de megas para hoje? Encontre na Megabyte pacotes diários a partir de 20 MT para o seu número ou para outro número Vodacom.",
    sectionHeading: "Compra rápida e simples",
    paragraphs: [
      "Abra a loja, escolha o pacote diário, informe o número beneficiário e pague com M-Pesa ou e-Mola. O catálogo apresenta o pacote e o preço antes de confirmar.",
    ],
    cta: "Ver pacotes diários",
  },
  "/pacotes-semanais": {
    title: "Pacotes Semanais Vodacom | Megabyte",
    description:
      "Compre pacotes semanais de internet Vodacom na Megabyte. Escolha os megas para a semana e pague com M-Pesa ou e-Mola.",
    canonical: "https://megabyte.live/pacotes-semanais/",
    eyebrow: "Pacotes Vodacom",
    heading: "Pacotes semanais de internet Vodacom",
    lead:
      "Compre megas para a semana na Megabyte e escolha se o pacote deve ser activado no seu número ou enviado para outra pessoa.",
    sectionHeading: "Pagamento por M-Pesa ou e-Mola",
    paragraphs: [
      "O preço e os megas aparecem na loja antes da compra. Depois do pagamento, o pacote é encaminhado para o número Vodacom indicado.",
    ],
    cta: "Ver pacotes semanais",
  },
  "/pacotes-mensais": {
    title: "Pacotes Mensais Vodacom | Megabyte",
    description:
      "Encontre pacotes mensais de internet Vodacom na Megabyte. Compre megas para o seu número ou para outra pessoa em Moçambique.",
    canonical: "https://megabyte.live/pacotes-mensais/",
    eyebrow: "Pacotes Vodacom",
    heading: "Pacotes mensais de internet Vodacom",
    lead:
      "Escolha um pacote mensal de megas para manter o seu número Vodacom ligado durante mais tempo.",
    sectionHeading: "Para o seu número ou para outro",
    paragraphs: [
      "A Megabyte permite seleccionar o destinatário antes de pagar. Use M-Pesa ou e-Mola e confirme os megas e o número na loja.",
    ],
    cta: "Ver pacotes mensais",
  },
  "/compra-de-megas-em-grupo": {
    title: "Compra de Megas para um Grupo | Megabyte",
    description:
      "Procura compra de megas para um grupo? Na Megabyte pode comprar pacotes de internet Vodacom para diferentes números, uma compra de cada vez.",
    canonical: "https://megabyte.live/compra-de-megas-em-grupo/",
    eyebrow: "Compra para várias pessoas",
    heading: "Compra de megas para um grupo",
    lead:
      "Se precisa de comprar megas para colegas, família ou um grupo de pessoas, pode enviar pacotes de internet Vodacom para diferentes números através da Megabyte.",
    sectionHeading: "Como funciona",
    steps: [
      "Abra a loja e escolha os megas para a primeira pessoa.",
      "Informe o número Vodacom que deve receber o pacote.",
      "Conclua o pagamento e repita o processo para cada número do grupo.",
    ],
    paragraphs: [
      "A loja processa cada número individualmente para mostrar sempre o pacote, o destinatário e o pagamento correctos.",
    ],
    cta: "Começar uma compra",
  },
};

function normalizedPathname(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function updateMeta(selector: string, attribute: string, value: string) {
  const element = document.querySelector<HTMLMetaElement>(selector);
  if (element) element.setAttribute(attribute, value);
}

function SeoLandingPage({ page }: { page: SeoPage }) {
  useEffect(() => {
    document.title = page.title;
    updateMeta('meta[name="description"]', "content", page.description);
    updateMeta('meta[property="og:title"]', "content", page.title);
    updateMeta('meta[property="og:description"]', "content", page.description);
    updateMeta('meta[property="og:url"]', "content", page.canonical);
    updateMeta('meta[name="twitter:title"]', "content", page.title);
    updateMeta('meta[name="twitter:description"]', "content", page.description);

    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = page.canonical;

    let structuredData = document.querySelector<HTMLScriptElement>("#seo-page-structured-data");
    if (!structuredData) {
      structuredData = document.createElement("script");
      structuredData.id = "seo-page-structured-data";
      structuredData.type = "application/ld+json";
      document.head.appendChild(structuredData);
    }
    structuredData.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.heading,
      description: page.description,
      url: page.canonical,
      inLanguage: "pt-MZ",
      isPartOf: { "@id": "https://megabyte.live/#website" },
    });

    return () => {
      structuredData?.remove();
    };
  }, [page]);

  return (
    <div className="seo-route-page">
      <header className="seo-header">
        <a className="seo-brand" href="/">
          <span className="seo-brand-mark" aria-hidden="true">M</span>
          Megabyte
        </a>
        <a className="seo-header-link" href="/">Abrir loja</a>
      </header>
      <main className="seo-main">
        <p className="seo-eyebrow">{page.eyebrow}</p>
        <h1>{page.heading}</h1>
        <p className="seo-lead">{page.lead}</p>
        <a className="seo-cta" href="/">{page.cta}</a>
        <h2>{page.sectionHeading}</h2>
        {page.steps && (
          <ol>
            {page.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        )}
        {page.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {page.items && (
          <ul className="seo-grid">
            {page.items.map((item) => (
              <li className="seo-card" key={item.heading}>
                <strong>{item.heading}</strong>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
      <footer className="seo-footer">
        Megabyte — pacotes de internet Vodacom em Moçambique.
      </footer>
    </div>
  );
}

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

  const seoPage = SEO_PAGES[normalizedPathname(window.location.pathname)];
  if (seoPage) {
    return <SeoLandingPage page={seoPage} />;
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
