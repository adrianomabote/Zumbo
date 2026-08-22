import { useEffect } from "react";

function App() {
  useEffect(() => {
    // The legacy admin panel is served by the API bridge. Redirect friendly
    // public URLs before the storefront iframe is mounted over them.
    if (window.location.pathname.startsWith("/admin")) {
      const target = `/api/legacy${window.location.pathname}${window.location.search}`;
      window.location.replace(target);
    }
  }, []);

  if (window.location.pathname.startsWith("/admin")) {
    return null;
  }

  return (
    <iframe
      title="Net Serviços"
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
