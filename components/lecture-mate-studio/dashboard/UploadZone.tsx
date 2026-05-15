import {
  CloudUpload,
  FileText,
  Presentation,
  FileBox,
  Loader2,
} from "lucide-react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";


interface UploadZoneProps {
  handleFileAnalyze: (file: File) => Promise<void>;
  isAnalyzing: boolean;
  selectedModel: "gpu" | "api";
}

export default function UploadZone({ handleFileAnalyze, isAnalyzing }: UploadZoneProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { language } = useLanguage();

  const t = {
    analyzing: language === "ar" ? "جاري معالجة الملف..." : "Analyzing File...",
    drop: language === "ar" ? "أفلت ملفاتك هنا" : "Drop files here",
    desc: language === "ar" 
      ? "قم برفع ملفات PDF، PPTX، أو DOCX لبدء عملية التنسيق الذكي." 
      : "Upload PDF, PPTX or DOCX files to start the smart curation process.",
    maxSize: language === "ar" ? "الحد الأقصى لحجم الملف 50 ميجابايت." : "Max file size: 50MB"
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileAnalyze(file);
    }
  };

  const handleContainerClick = () => {
    if (!isAnalyzing) {
      fileInputRef.current?.click();
    }
  };

  return (
    <div 
      onClick={handleContainerClick}
      className="w-full flex-1 h-full min-h-[260px] bg-surface-container-lowest rounded-2xl p-10 flex flex-col items-center justify-center border-2 border-dashed border-outline-variant hover:border-[#F05A22]/50 transition-colors cursor-pointer group shadow-[0_2px_12px_rgba(0,0,0,0.04)]"
    >
      <input 
        type="file"
        ref={fileInputRef}
        onChange={onFileChange}
        className="hidden"
        accept="audio/*,video/*,.pdf,.doc,.docx,.ppt,.pptx"
        title="Upload lecture files"
        aria-label="Upload lecture files"
      />
      
      <motion.div
        whileHover={{ scale: 1.05 }}
        className="w-[4.5rem] h-[4.5rem] bg-[#F05A22]/10 rounded-full flex items-center justify-center mb-5"
      >
        {isAnalyzing ? (
          <Loader2 className="text-[#F05A22] animate-spin" size={36} strokeWidth={2} />
        ) : (
          <CloudUpload className="text-[#F05A22]" size={36} strokeWidth={2} />
        )}
      </motion.div>

      <h3 className="text-xl sm:text-2xl font-bold mb-2 font-headline tracking-tight text-on-surface">
        {isAnalyzing ? t.analyzing : t.drop}
      </h3>
      <p className="text-on-surface-variant text-center mb-7 text-sm sm:text-[15px] leading-relaxed max-w-md">
        {t.desc}
        <br className="hidden sm:block" />
        {t.maxSize}
      </p>



      <div className="flex flex-wrap justify-center gap-3">
        {[
          { icon: FileText, label: "PDF" },
          { icon: Presentation, label: "PPT" },
          { icon: FileBox, label: "DOCX" },
        ].map((item) => (
          <div
            key={item.label}
            className="px-3.5 py-2 bg-surface-container-low rounded-lg flex items-center gap-2 text-xs font-semibold text-on-surface-variant border border-outline-variant/80"
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
