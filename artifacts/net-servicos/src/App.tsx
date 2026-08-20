function App() {
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
