import NightSky from "@/components/landing/NightSky";
import LandingNav from "@/components/landing/LandingNav";
import Hero from "@/components/landing/Hero";
import Story from "@/components/landing/Story";
import { FinalCall, HowItRuns, Proof, RulesGallery } from "@/components/landing/Sections";
import "@/components/landing/landing.css";

export default function Home() {
  return (
    <div className="night relative isolate min-h-screen overflow-x-clip">
      <NightSky />
      <LandingNav />
      <main className="relative z-10">
        <Hero />
        <Story />
        <RulesGallery />
        <HowItRuns />
        <Proof />
        <FinalCall />
      </main>
    </div>
  );
}
