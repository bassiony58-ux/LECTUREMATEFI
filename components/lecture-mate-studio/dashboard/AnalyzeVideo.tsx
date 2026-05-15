import { useState } from "react";
import { Video, BarChart2, Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";


interface AnalyzeVideoProps {
  handleAnalyze: (url: string, startTimeSeconds?: number | null, endTimeSeconds?: number | null) => Promise<void>;
  isAnalyzing: boolean;
  selectedModel: "gpu" | "api";
}

export default function AnalyzeVideo({ handleAnalyze, isAnalyzing, selectedModel }: AnalyzeVideoProps) {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const { language, isRTL } = useLanguage();

  const t = {
    title: language === "ar" ? "تحليل مقطع فيديو" : "Analyze Video Link",
    desc: language === "ar" 
      ? "ألصق رابط يوتيوب لإنشاء نصوص وملخصات احترافية بشكل فوري." 
      : "Paste a YouTube link to generate transcripts and professional summaries instantly.",
    label: language === "ar" ? "رابط الفيديو" : "VIDEO URL",
    analyzing: language === "ar" ? "جاري التحليل..." : "Analyzing...",
    start: language === "ar" ? "ابدأ التحليل الآن" : "Start Analysis Now",
    segment: language === "ar" ? "تحديد مقطع (اختياري)" : "Video Segment (Optional)",
    startTime: language === "ar" ? "بداية (00:00)" : "Start (00:00)",
    endTime: language === "ar" ? "نهاية (00:00)" : "End (00:00)",
  };

  const timeToSeconds = (timeStr: string): number | undefined => {
    if (!timeStr) return undefined;
    if (timeStr.includes(':')) {
      const parts = timeStr.split(':').reverse();
      let seconds = 0;
      if (parts[0]) seconds += parseInt(parts[0]) || 0;
      if (parts[1]) seconds += (parseInt(parts[1]) || 0) * 60;
      if (parts[2]) seconds += (parseInt(parts[2]) || 0) * 3600;
      return seconds;
    }
    return parseInt(timeStr);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const start = timeToSeconds(startTime);
    const end = timeToSeconds(endTime);
    handleAnalyze(url, start, end);
  };

  return (
    <div className="w-full flex-1 bg-surface-container-low rounded-2xl p-8 sm:p-10 flex flex-col justify-between relative overflow-hidden h-full min-h-[260px] shadow-[0_2px_12px_rgba(0,0,0,0.04)] border border-outline-variant/50">
      <div className={cn(
        "absolute p-4 text-on-surface/[0.04] pointer-events-none select-none",
        isRTL ? "top-2 left-2" : "top-2 right-2"
      )}>
        <Video size={140} strokeWidth={1.25} />
      </div>

      <div className={cn("relative z-10 flex flex-col h-full", isRTL ? "text-right" : "text-left")} dir={isRTL ? "rtl" : "ltr"}>
        <h3 className="text-xl sm:text-2xl font-bold mb-3 font-headline tracking-tight text-on-surface">
          {t.title}
        </h3>
        <p className="text-on-surface-variant mb-7 text-sm leading-relaxed">
          {t.desc}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4 mt-auto">

          
          <div className={cn("relative", isRTL ? "text-right" : "text-left")}>
            <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant mb-2 block">
              {t.label}
            </label>
            <input
              type="text"
              placeholder="https://youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isAnalyzing}
              className={cn(
                "w-full bg-surface-container-lowest rounded-xl py-3 px-4 border border-outline-variant/60 shadow-inner shadow-black/[0.02] focus:ring-2 focus:ring-[#F05A22]/25 focus:border-transparent text-sm text-on-surface",
                isRTL ? "text-right" : "text-left"
              )}
              dir="ltr"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className={cn("relative", isRTL ? "text-right" : "text-left")}>
              <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant mb-2 block">
                {t.startTime}
              </label>
              <input
                type="text"
                placeholder="0"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={isAnalyzing}
                className={cn(
                  "w-full bg-surface-container-lowest rounded-xl py-2 px-3 border border-outline-variant/60 focus:ring-2 focus:ring-[#F05A22]/25 focus:border-transparent text-sm text-on-surface",
                  isRTL ? "text-right" : "text-left"
                )}
              />
            </div>
            <div className={cn("relative", isRTL ? "text-right" : "text-left")}>
              <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant mb-2 block">
                {t.endTime}
              </label>
              <input
                type="text"
                placeholder="---"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={isAnalyzing}
                className={cn(
                  "w-full bg-surface-container-lowest rounded-xl py-2 px-3 border border-outline-variant/60 focus:ring-2 focus:ring-[#F05A22]/25 focus:border-transparent text-sm text-on-surface",
                  isRTL ? "text-right" : "text-left"
                )}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isAnalyzing || !url}
            className={cn(
              "w-full bg-[#242424] text-white py-3.5 rounded-xl text-[15px] font-semibold flex items-center justify-center gap-2 hover:bg-[#1a1a1a] transition-all active:scale-[0.99] font-sans shadow-md disabled:opacity-50 disabled:cursor-not-allowed",
              isRTL ? "flex-row" : "flex-row"
            )}
          >
            {isAnalyzing ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <BarChart2 size={18} />
            )}
            <span>{isAnalyzing ? t.analyzing : t.start}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
