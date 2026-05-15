import Sidebar from "./layout/Sidebar";
import Header from "./layout/Header";
import Hero from "./dashboard/Hero";
import UploadZone from "./dashboard/UploadZone";
import AnalyzeVideo from "./dashboard/AnalyzeVideo";
import MasterySection from "./dashboard/MasterySection";
import Footer from "./layout/Footer";

import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import ProcessingModeSelector from "./dashboard/ProcessingModeSelector";
import { useLectureProcessor } from "@/hooks/useLectureProcessor";

/**
 * Lecture Mate dashboard shell exported from Google AI Studio (Downloads bundle),
 * integrated into the Vite client under client/src.
 */
export default function LectureMateStudioShell() {
  const { isRTL } = useLanguage();
  const { 
    handleAnalyze, 
    handleFileAnalyze, 
    isAnalyzing, 
    selectedModel, 
    setSelectedModel 
  } = useLectureProcessor();

  return (
    <div className="flex min-h-screen" dir={isRTL ? "rtl" : "ltr"}>
      <Sidebar />

      <main className={cn(
        "flex-1 bg-surface min-h-screen flex flex-col",
        isRTL ? "mr-64" : "ml-64"
      )}>
        <Header />

        <div className="px-8 sm:px-12 py-8 sm:py-10 flex-1">
          <div className="max-w-7xl mx-auto space-y-12 sm:space-y-14">
            <Hero />

            <div className="flex justify-center -mb-6">
              <div className="w-full max-w-md">
                <ProcessingModeSelector 
                  selectedMode={selectedModel} 
                  onChange={setSelectedModel} 
                  disabled={isAnalyzing}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-stretch">
              <div className="lg:col-span-8 flex">
                <UploadZone 
                  handleFileAnalyze={handleFileAnalyze} 
                  isAnalyzing={isAnalyzing} 
                  selectedModel={selectedModel}
                />
              </div>
              <div className="lg:col-span-4 flex">
                <AnalyzeVideo 
                  handleAnalyze={handleAnalyze} 
                  isAnalyzing={isAnalyzing} 
                  selectedModel={selectedModel}
                />
              </div>
            </div>

            <MasterySection />
          </div>
        </div>

        <Footer />
      </main>
    </div>
  );
}
