import { Cpu, Globe, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

interface ProcessingModeSelectorProps {
  selectedMode: "gpu" | "api";
  onChange: (mode: "gpu" | "api") => void;
  disabled?: boolean;
}

export default function ProcessingModeSelector({ 
  selectedMode, 
  onChange, 
  disabled 
}: ProcessingModeSelectorProps) {
  const { language, isRTL } = useLanguage();

  const t = {
    title: language === "ar" ? "وضع المعالجة" : "Processing Mode",
    api: language === "ar" ? "API الذكي (سحابي)" : "Smart API (Cloud)",
    gpu: language === "ar" ? "GPU المحلي (أداء عالٍ)" : "Local GPU (High Performance)",
    recommended: language === "ar" ? "موصى به" : "Recommended"
  };

  return (
    <div className="flex flex-col space-y-3 mb-6">
      <div className={cn("flex items-center gap-2", isRTL ? "flex-row-reverse" : "flex-row")}>
        <Zap size={16} className="text-[#F05A22]" />
        <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          {t.title}
        </span>
      </div>
      
      <div className="grid grid-cols-2 gap-3 p-1 bg-surface-container-low rounded-xl border border-outline-variant/40 shadow-sm">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("api")}
          className={cn(
            "flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-xs font-semibold transition-all relative overflow-hidden",
            selectedMode === "api" 
              ? "bg-[#242424] text-white shadow-md active:scale-[0.98]" 
              : "text-on-surface-variant hover:bg-surface-container-high"
          )}
        >
          <Globe size={14} />
          <span>{t.api}</span>
          {selectedMode === "api" && (
            <span className="absolute top-0 right-0 bg-[#F05A22] text-[8px] px-1.5 py-0.5 rounded-bl-md font-bold text-white uppercase tracking-wider">
              {t.recommended}
            </span>
          )}
        </button>

        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("gpu")}
          className={cn(
            "flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-xs font-semibold transition-all",
            selectedMode === "gpu" 
              ? "bg-[#242424] text-white shadow-md active:scale-[0.98]" 
              : "text-on-surface-variant hover:bg-surface-container-high"
          )}
        >
          <Cpu size={14} />
          <span>{t.gpu}</span>
        </button>
      </div>
    </div>
  );
}
