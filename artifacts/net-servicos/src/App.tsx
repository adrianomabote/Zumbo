import { useEffect, useRef, useState } from "react";
import "./seo-page.css";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const PUBLIC_SEO_PAGES: Record<string, { title: string; description: string }> = {
  "/pacotes-diarios": {
    title: "Pacotes Diários Vodacom em Moçambique | Megabyte",
    description:
      "Compre pacotes diários de internet Vodacom em Moçambique usando o saldo da sua conta Megabyte.",
  },
  "/pacotes-semanais": {
    title: "Pacotes Semanais Vodacom em Moçambique | Megabyte",
    description:
      "Encontre pacotes semanais de internet Vodacom em Moçambique e compre-os com o saldo da sua conta Megabyte.",
  },
  "/pacotes-mensais": {
    title: "Pacotes Mensais Vodacom em Moçambique | Megabyte",
    description:
      "Compre pacotes mensais de internet Vodacom em Moçambique usando o saldo disponível na sua conta Megabyte.",
  },
  "/pacotes-diamante": {
    title: "Pacotes Diamante Vodacom em Moçambique | Megabyte",
    description:
      "Conheça os pacotes Diamante Vodacom em Moçambique, com dados e chamadas mais completas. Compre com o saldo Megabyte.",
  },
  "/pacotes-internet-vodacom": {
    title: "Pacotes de Internet Vodacom em Moçambique | Megabyte",
    description:
      "Compre pacotes de internet Vodacom em Moçambique para o seu número ou para outra pessoa. Veja as ofertas diárias, semanais, mensais e Diamante disponíveis.",
  },
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
      "Compre megas e pacotes de internet Vodacom em Moçambique na Megabyte usando o saldo da sua conta.",
    canonical: "https://megabyte.live/comprar-megas/",
    eyebrow: "Internet Vodacom",
    heading: "Comprar megas Vodacom em Moçambique",
    lead:
      "Escolha pacotes de internet para o seu número Vodacom ou envie megas para outra pessoa de forma simples.",
    sectionHeading: "Como comprar megas",
    steps: [
      "Abra a loja e escolha o pacote de internet disponível.",
      "Indique o número Vodacom que deve receber os megas.",
      "Confirme a compra para descontar o valor do seu saldo Megabyte.",
    ],
    cta: "Comprar agora",
  },
  "/pacotes-diarios": {
    title: "Pacotes Diários Vodacom a partir de 10 MT | Megabyte",
    description:
      "Veja os pacotes diários de internet Vodacom da Megabyte, a partir de 10 MT. Compre-os com o saldo da sua conta.",
    canonical: "https://megabyte.live/pacotes-diarios/",
    eyebrow: "Pacotes Vodacom",
    heading: "Pacotes diários de internet Vodacom",
    lead:
      "Precisa de megas para hoje? Encontre na Megabyte pacotes diários a partir de 10 MT para o seu número ou para outro número Vodacom.",
    sectionHeading: "Compra rápida e simples",
    paragraphs: [
      "Abra a loja, escolha o pacote diário e informe o número beneficiário. O valor é descontado do saldo da sua conta.",
    ],
    cta: "Ver pacotes diários",
  },
  "/pacotes-semanais": {
    title: "Pacotes Semanais Vodacom | Megabyte",
    description:
      "Compre pacotes semanais de internet Vodacom na Megabyte usando o saldo da sua conta.",
    canonical: "https://megabyte.live/pacotes-semanais/",
    eyebrow: "Pacotes Vodacom",
    heading: "Pacotes semanais de internet Vodacom",
    lead:
      "Compre megas para a semana na Megabyte e escolha se o pacote deve ser activado no seu número ou enviado para outra pessoa.",
    sectionHeading: "Pagamento com saldo Megabyte",
    paragraphs: [
      "O preço e os megas aparecem na loja antes da compra. O valor é descontado do saldo e o pacote é encaminhado para o número Vodacom indicado.",
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
      "A Megabyte permite seleccionar o destinatário antes de pagar com o saldo da sua conta. Confirme os megas e o número na loja.",
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
  "/comprar-megas-online": {
    title: "Comprar Megas Online em Moçambique | Megabyte",
    description:
      "Compre megas online em Moçambique na Megabyte. Escolha um pacote de internet Vodacom, indique o número e pague com o seu saldo.",
    canonical: "https://megabyte.live/comprar-megas-online/",
    eyebrow: "Megabyte Moçambique",
    heading: "Comprar megas online em Moçambique",
    lead:
      "Encontre uma forma simples de comprar pacotes de internet Vodacom online para o seu número ou para outra pessoa.",
    sectionHeading: "Como comprar megas online",
    steps: [
      "Abra a loja Megabyte e veja os pacotes de internet disponíveis.",
      "Escolha a quantidade de megas e indique o número Vodacom beneficiário.",
      "Confirme os dados e pague com o saldo da sua conta Megabyte.",
    ],
    paragraphs: [
      "Pode escolher entre pacotes diários, semanais, mensais e Diamante conforme a oferta disponível no catálogo.",
      "O preço e a quantidade de dados são apresentados antes de confirmar a compra.",
    ],
    cta: "Comprar agora",
  },
  "/comprar-megas-para-outra-pessoa": {
    title: "Comprar Megas para Outra Pessoa | Megabyte",
    description:
      "Quer oferecer megas? Compre um pacote de internet Vodacom para outra pessoa na Megabyte usando o saldo da sua conta.",
    canonical: "https://megabyte.live/comprar-megas-para-outra-pessoa/",
    eyebrow: "Megabyte Moçambique",
    heading: "Comprar megas para outra pessoa",
    lead:
      "Envie um pacote de internet Vodacom para um familiar, amigo ou colega indicando o número que deve receber os megas.",
    sectionHeading: "Enviar megas para outro número",
    steps: [
      "Escolha o pacote de internet que pretende oferecer.",
      "Seleccione a opção para outro destinatário e escreva o número Vodacom.",
      "Confirme o número e conclua a compra com o saldo da sua conta.",
    ],
    paragraphs: [
      "A Megabyte permite comprar megas para outro número sem confundir o pagador com o beneficiário.",
      "Para comprar para várias pessoas, repita a compra individualmente para cada número do grupo.",
    ],
    cta: "Começar uma compra",
  },
  "/pagar-megas-mpesa-emola": {
    title: "Recarregar Saldo com M-Pesa ou e-Mola | Megabyte",
    description:
      "Recarregue o saldo da sua conta Megabyte com M-Pesa ou e-Mola e use-o para activar pacotes de megas.",
    canonical: "https://megabyte.live/pagar-megas-mpesa-emola/",
    eyebrow: "Recargas de saldo",
    heading: "Recarregar saldo com M-Pesa ou e-Mola",
    lead:
      "Adicione saldo à sua conta Megabyte por M-Pesa ou e-Mola. Depois, use o saldo para comprar pacotes de internet Vodacom.",
    sectionHeading: "Como recarregar e comprar pacotes",
    steps: [
      "Entre na sua conta Megabyte e escolha a opção para recarregar saldo.",
      "Confirme a recarga com M-Pesa ou e-Mola no telemóvel associado à conta.",
      "Escolha um pacote e pague com o saldo disponível na sua conta.",
    ],
    paragraphs: [
      "M-Pesa e e-Mola servem para adicionar saldo à conta; não são métodos de pagamento directo de pacotes.",
      "Ao comprar um pacote, o valor é descontado do saldo da conta Megabyte.",
    ],
    cta: "Comprar agora",
  },
  "/megas-baratos-vodacom": {
    title: "Megas Baratos Vodacom a partir de 10 MT | Megabyte",
    description:
      "Procura megas baratos em Moçambique? Veja opções de internet Vodacom a partir de 10 MT e pague com saldo Megabyte.",
    canonical: "https://megabyte.live/megas-baratos-vodacom/",
    eyebrow: "Pacotes acessíveis",
    heading: "Megas baratos Vodacom a partir de 10 MT",
    lead:
      "Compare as opções de megas Vodacom disponíveis na Megabyte. Os pacotes a partir de 10 MT são pagos com saldo de crédito.",
    sectionHeading: "Opções de internet a partir de 10 MT",
    paragraphs: [
      "O catálogo da Megabyte inclui pacotes de internet Vodacom a partir de 10 MT, pagos com o saldo da sua conta.",
      "Se pesquisou por “Vodacom megas”, “megas baratos” ou “internet móvel barata”, abra a loja para ver as ofertas actuais.",
    ],
    steps: [
      "Compare o preço, a quantidade de megas e o período de validade.",
      "Escolha o número Vodacom que deve receber o pacote.",
      "Escolha o pacote e pague com o saldo da sua conta. Se precisar, recarregue o saldo com M-Pesa ou e-Mola.",
    ],
    cta: "Ver megas disponíveis",
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

function MaintenanceScreen() {
  return (
    <main className="maintenance-screen" role="status" aria-live="polite">
      <section className="maintenance-card">
        <div className="maintenance-brand">
          <img
            className="maintenance-brand-logo"
            src={`${import.meta.env.BASE_URL}api/legacy/static/vodacom.webp`}
            alt="Vodacom"
          />
          Megabyte
        </div>
        <div className="maintenance-icon" aria-hidden="true">!</div>
        <h1>Estamos em manutenção</h1>
        <p>
          Estamos a fazer uma manutenção rápida para melhorar a loja.
          Voltamos em breve.
        </p>
        <div className="maintenance-notice">
          Por favor, volte a tentar dentro de alguns minutos.
        </div>
      </section>
    </main>
  );
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
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  const installDismissKey = "pwa-install-notice-dismissed-v2";
  const publicPath = normalizedPathname(window.location.pathname);
  const publicPage = PUBLIC_SEO_PAGES[publicPath];

  useEffect(() => {
    // The legacy admin panel is served by the API bridge. Redirect friendly
    // public URLs before the storefront iframe is mounted over them.
    if (window.location.pathname.startsWith("/admin")) {
      const target = `/api/legacy${window.location.pathname}${window.location.search}`;
      window.location.replace(target);
      return;
    }

    fetch(`${import.meta.env.BASE_URL}api/legacy/api/maintenance-status`, {
      cache: "no-store",
    })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("maintenance status unavailable")))
      .then((data: { enabled?: boolean }) => setMaintenance(data.enabled === true))
      .catch(() => setMaintenance(false));

    if (publicPage) {
      document.title = publicPage.title;
      updateMeta('meta[name="description"]', "content", publicPage.description);
      updateMeta('meta[property="og:title"]', "content", publicPage.title);
      updateMeta('meta[property="og:description"]', "content", publicPage.description);
      updateMeta('meta[property="og:url"]', "content", `${window.location.origin}${publicPath}`);
      updateMeta('meta[name="twitter:title"]', "content", publicPage.title);
      updateMeta('meta[name="twitter:description"]', "content", publicPage.description);
      const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (canonical) canonical.href = `${window.location.origin}${publicPath}`;
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

  useEffect(() => {
    const onStorefrontMessage = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== storefrontRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object"
      ) {
        return;
      }
      const message = event.data as { type?: unknown; checkoutUrl?: unknown };
      if (message.type !== "megabyte:vpay-checkout" || typeof message.checkoutUrl !== "string") return;
      try {
        const checkout = new URL(message.checkoutUrl);
        if (
          checkout.protocol !== "https:" ||
          checkout.hostname !== "checkout.vpay.co.mz" ||
          checkout.port ||
          checkout.username ||
          checkout.password ||
          checkout.pathname === "/"
        ) {
          return;
        }
        window.location.assign(checkout.href);
      } catch {
        // Ignore malformed messages from the embedded storefront.
      }
    };
    window.addEventListener("message", onStorefrontMessage);
    return () => window.removeEventListener("message", onStorefrontMessage);
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

  if (maintenance === true) {
    return <MaintenanceScreen />;
  }

  if (maintenance === null) {
    return <div className="maintenance-loading" aria-busy="true">A carregar…</div>;
  }

  const seoPage = SEO_PAGES[publicPath];
  if (seoPage && !publicPage) {
    return <SeoLandingPage page={seoPage} />;
  }

  const storefrontPath = publicPage ? publicPath : "/megas";

  return (
    <>
      <iframe
        title="Loja Megabyte — comprar pacotes de internet Vodacom"
        ref={storefrontRef}
        src={`${import.meta.env.BASE_URL}api/legacy${storefrontPath}`}
        style={{
          border: 0,
          display: "block",
          height: "100vh",
          width: "100vw",
        }}
      />
      {installVisible && (
        <div className="pwa-install-notice" role="region" aria-label="Instalar aplicação Megabyte">
          <div className="pwa-install-notice-icon" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}api/legacy/static/icon-192.png?v=6`} alt="" />
          </div>
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
