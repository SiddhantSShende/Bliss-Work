import { Routes, Route } from "react-router-dom";
import { DownloadProvider } from "@/components/download/DownloadProvider";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { ScrollToTop } from "@/components/ScrollToTop";
import Home from "@/pages/Home";
import Userflow from "@/pages/Userflow";
import Architect from "@/pages/Architect";
import About from "@/pages/About";
import Privacy from "@/pages/Privacy";
import Security from "@/pages/Security";
import Terms from "@/pages/Terms";
import DPA from "@/pages/DPA";

export function App() {
  return (
    <DownloadProvider>
      <ScrollToTop />
      <Navbar />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/userflow" element={<Userflow />} />
          <Route path="/architect" element={<Architect />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/security" element={<Security />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/dpa" element={<DPA />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <Footer />
    </DownloadProvider>
  );
}
