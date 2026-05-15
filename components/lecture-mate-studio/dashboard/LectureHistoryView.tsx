import { useState, useMemo, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { 
  ArrowRight, 
  ArrowLeft, 
  Filter, 
  Trash2, 
  Eye, 
  FileText,
  FileVideo,
  Presentation,
  RotateCcw 
} from "lucide-react";
import { format, formatDistanceToNow, isAfter, subDays } from "date-fns";
import { ar, enUS } from "date-fns/locale";
import { useLectures } from "@/hooks/useLectures";
import { cn } from "@/lib/utils";
import type { Lecture, LectureCategory } from "@/lib/mockData";
import { useLanguage } from "@/contexts/LanguageContext";

const CATEGORY_LABELS: Record<string, { en: string; ar: string }> = {
  science: { en: "Science", ar: "العلوم" },
  technology: { en: "Technology", ar: "التكنولوجيا" },
  mathematics: { en: "Mathematics", ar: "الرياضيات" },
  medicine: { en: "Medicine", ar: "الطب" },
  history: { en: "History", ar: "التاريخ" },
  art: { en: "Art & Design", ar: "الفن والتصميم" },
  language: { en: "Languages", ar: "اللغات" },
  business: { en: "Business", ar: "الأعمال" },
  education: { en: "Education", ar: "التعليم" },
  other: { en: "Other Topics", ar: "مواضيع أخرى" }
};

export default function LectureHistoryView() {
  const { lectures, isLoading, deleteLecture } = useLectures();
  const [location, setLocation] = useLocation();
  const { language, isRTL } = useLanguage();
  
  // Make search params reactive
  const [search, setSearch] = useState(typeof window !== 'undefined' ? window.location.search : '');
  
  // Detect search changes even if pathname is the same
  useEffect(() => {
    const handlePopState = () => setSearch(window.location.search);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Also listen to wouter's location changes for initial mount and path changes
  useEffect(() => {
    setSearch(window.location.search);
  }, [location]);

  const { urlCategory, searchQuery } = useMemo(() => {
    const params = new URLSearchParams(search);
    return {
      urlCategory: params.get('category') as LectureCategory | null,
      searchQuery: params.get('q')?.toLowerCase() || ""
    };
  }, [search]);

  const [filter, setFilter] = useState<"all" | "pdf" | "youtube" | "ppt">("all");
  
  const t = {
    historyTitle: language === "ar" ? "مكتبتي الشاملة" : "My Global Library",
    libraryTitle: language === "ar" ? "مجموعة" : "Collection",
    backToDomains: language === "ar" ? "العودة للتصنيفات" : "Back to Categories",
    sortBy: language === "ar" ? "ترتيب حسب:" : "Sort by:",
    newest: language === "ar" ? "الأحدث أولاً" : "Newest First",
    filters: [
      { id: "all", label: language === "ar" ? "الكل" : "All" },
      { id: "pdf", label: language === "ar" ? "بي دي إف" : "PDFs" },
      { id: "youtube", label: language === "ar" ? "يوتيوب" : "Videos" },
      { id: "ppt", label: language === "ar" ? "بوربوينت" : "Presentations" }
    ],
    prev: language === "ar" ? "السابق" : "Previous",
    next: language === "ar" ? "التالي" : "Next",
    noResults: language === "ar" ? "لم يتم العثور على محاضرات تطابق الفلتر الحالي." : "No lectures found matching the current filter.",
    resetFilters: language === "ar" ? "إعادة ضبط المرشحات" : "Reset Filters"
  };

  const filteredLectures = useMemo(() => {
    let result = lectures;
    if (urlCategory) {
      result = result.filter(l => (l.category || 'other') === urlCategory);
    }
    if (searchQuery) {
      result = result.filter(l => (l.title || "").toLowerCase().includes(searchQuery));
    }
    return result.filter(l => {
      const type = l.sourceType || (l.geminiFileMimeType?.includes("pdf") ? "pdf" : l.geminiFileMimeType?.includes("presentation") ? "pptx" : "youtube");
      if (filter === "all") return true;
      if (filter === "youtube") return type === "youtube";
      if (filter === "pdf") return type === "pdf";
      if (filter === "ppt") return type === "pptx";
      return true;
    });
  }, [lectures, filter, urlCategory, searchQuery]);

  const categoryName = urlCategory ? (language === "ar" ? CATEGORY_LABELS[urlCategory]?.ar : CATEGORY_LABELS[urlCategory]?.en) || urlCategory : "";

  return (
    <div className="space-y-10" dir={isRTL ? "rtl" : "ltr"}>
      <div className={cn("flex flex-col sm:flex-row sm:items-center justify-between gap-6", isRTL ? "flex-row" : "flex-row")}>
        <div className={isRTL ? "text-right" : "text-left"}>
          <h2 className="text-4xl font-black text-on-surface tracking-tight font-headline">
            {urlCategory 
              ? (language === "ar" ? `${categoryName} ${t.libraryTitle}` : `${categoryName} ${t.libraryTitle}`) 
              : t.historyTitle}
          </h2>
          {urlCategory && (
            <Link href="/categories" className={cn(
              "text-sm font-bold text-[#F05A22] hover:underline flex items-center gap-1.5 mt-2",
              isRTL ? "justify-end" : "justify-start"
            )}>
               {isRTL ? <ArrowRight size={16} /> : <ArrowLeft size={16} />}
               <span>{t.backToDomains}</span>
            </Link>
          )}
        </div>
        
        <div className={cn("flex items-center gap-3 text-sm text-on-surface-variant font-medium", isRTL ? "flex-row" : "flex-row")}>
          <Filter size={16} />
          <span>{t.sortBy}</span>
          <button className="text-on-surface font-bold bg-transparent border-0 cursor-pointer p-0 hover:text-[#F05A22] transition-colors">
            {t.newest}
          </button>
        </div>
      </div>

      <div className={cn("flex flex-wrap gap-3", isRTL ? "flex-row" : "flex-row")}>
        {t.filters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id as any)}
            className={cn(
              "px-6 py-2 rounded-full text-sm font-bold transition-all border-0 cursor-pointer shadow-sm",
              filter === f.id 
                ? "bg-[#F05A22] text-white scale-105" 
                : "bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filteredLectures.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {filteredLectures.map((lecture) => (
            <HistoryCard 
              key={lecture.id} 
              lecture={lecture} 
              onDelete={() => deleteLecture(lecture.id)}
            />
          ))}
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-[2.5rem] p-16 text-center border border-outline-variant/30">
          <div className="w-16 h-16 rounded-full bg-[#F05A22]/10 flex items-center justify-center mx-auto mb-6 text-[#F05A22]">
            <Filter size={32} />
          </div>
          <p className="text-on-surface-variant font-medium mb-6">{t.noResults}</p>
          <button 
            onClick={() => { setFilter("all"); setLocation("/history"); }}
            className="px-8 py-3 bg-[#1d1d1f] dark:bg-white text-white dark:text-[#1d1d1f] rounded-full font-bold text-sm shadow-lg hover:shadow-[#F05A22]/20 transition-all hover:-translate-y-0.5"
          >
            {t.resetFilters}
          </button>
        </div>
      )}

      {filteredLectures.length > 0 && (
        <div className={cn("flex items-center justify-center gap-2 pt-10 pb-6", isRTL ? "flex-row" : "flex-row")}>
          <button 
            aria-label={t.prev}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-white border border-outline-variant/30 text-on-surface-variant hover:text-[#F05A22] transition-colors shadow-sm cursor-pointer"
          >
            {isRTL ? <ArrowRight size={18} /> : <ArrowLeft size={18} />}
          </button>
          <button className="w-10 h-10 rounded-full flex items-center justify-center bg-[#F05A22] text-white font-bold shadow-md cursor-pointer">1</button>
          <button className="w-10 h-10 rounded-full flex items-center justify-center bg-white text-on-surface-variant font-bold hover:bg-surface-container-low transition-colors cursor-pointer">2</button>
          <button className="w-10 h-10 rounded-full flex items-center justify-center bg-white text-on-surface-variant font-bold hover:bg-surface-container-low transition-colors cursor-pointer">3</button>
          <span className="text-on-surface-variant/40 px-2">...</span>
          <button className="w-10 h-10 rounded-full flex items-center justify-center bg-white text-on-surface-variant font-bold hover:bg-surface-container-low transition-colors cursor-pointer">12</button>
          <button 
            aria-label={t.next}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-white border border-outline-variant/30 text-on-surface-variant hover:text-[#F05A22] transition-colors shadow-sm cursor-pointer"
          >
            {isRTL ? <ArrowLeft size={18} /> : <ArrowRight size={18} />}
          </button>
        </div>
      )}
    </div>
  );
}

function HistoryCard({ lecture, onDelete }: { lecture: Lecture, onDelete: () => void }) {
  const { language, isRTL } = useLanguage();
  
  const getFileStyle = () => {
    const title = (lecture.title || "").toLowerCase();
    const isPdfByTitle = title.includes(".pdf");
    const isPptByTitle = title.includes(".ppt") || title.includes(".pptx");

    let type = lecture.sourceType || (lecture.geminiFileMimeType?.includes("pdf") ? "pdf" : lecture.geminiFileMimeType?.includes("presentation") ? "pptx" : "");
    
    // Fallback to title-based detection if explicit type is missing or generic
    if (!type || type === "youtube" || type === "video" || type === "audio") {
      if (isPdfByTitle) type = "pdf";
      else if (isPptByTitle) type = "pptx";
      else if (!type) type = "youtube"; // Default to youtube if nothing else fits
    }
    
    switch (type) {
      case "youtube":
      case "video":
        return { 
          icon: <FileVideo size={24} />, 
          bgColor: "bg-red-50", 
          accentColor: "bg-red-600",
          label: "Video",
          isVideo: true 
        };
      case "pptx":
        return { 
          icon: <Presentation size={24} />, 
          bgColor: "bg-orange-50", 
          accentColor: "bg-orange-500",
          label: "PPTX",
          isVideo: false 
        };
      case "pdf":
        return { 
          icon: <FileText size={24} />, 
          bgColor: "bg-blue-50", 
          accentColor: "bg-blue-600",
          label: "PDF",
          isVideo: false 
        };
      default:
        return { 
          icon: <FileText size={24} />, 
          bgColor: "bg-slate-50", 
          accentColor: "bg-[#F05A22]",
          label: "File",
          isVideo: false 
        };
    }
  };

  const style = getFileStyle();
  const isArchived = lecture.status === "failed" || lecture.status === "archived";

  const getFormattedDate = () => {
    if (lecture.date && (lecture.date.includes("Today") || lecture.date.includes("Yesterday"))) {
      return lecture.date;
    }

    try {
      const dateObj = new Date(lecture.createdAt || lecture.date || Date.now());
      if (isNaN(dateObj.getTime())) return lecture.date || "";
      const locale = language === "ar" ? ar : enUS;
      if (isAfter(dateObj, subDays(new Date(), 6))) {
        return formatDistanceToNow(dateObj, { addSuffix: true, locale });
      }
      return format(dateObj, language === "ar" ? "d MMMM yyyy" : "MMMM d, yyyy", { locale });
    } catch (e) {
      return lecture.date || "";
    }
  };

  const getDateComponents = () => {
    const dateObj = new Date(lecture.createdAt || lecture.date || Date.now());
    if (isNaN(dateObj.getTime())) return null;
    return {
      month: format(dateObj, "MMM", { locale: language === "ar" ? ar : enUS }),
      day: format(dateObj, "d"),
    };
  };

  const dateParts = getDateComponents();

  const t = {
    archived: language === "ar" ? "مؤرشفة" : "Archived",
    completed: language === "ar" ? "مكتملة" : "Complete",
    analyzed: language === "ar" ? "تم التحليل:" : "Analyzed:",
    restore: language === "ar" ? "استعادة" : "Restore",
    view: language === "ar" ? "عرض" : "View Open"
  };
  
  return (
    <div className="group relative bg-white rounded-[2.5rem] p-8 pb-10 shadow-[0_10px_40px_rgba(0,0,0,0.04)] border border-outline-variant/20 hover:shadow-[0_20px_60px_rgba(0,0,0,0.08)] transition-all duration-500 overflow-hidden text-center">
      <div className={cn("absolute top-8", isRTL ? "left-8" : "right-8")}>
        <div className={cn(
          "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm z-10",
          isArchived 
            ? "bg-orange-100 text-orange-700 border border-orange-200" 
            : "bg-green-50 text-emerald-600 border border-emerald-100"
        )}>
          {isArchived ? t.archived : t.completed}
        </div>
      </div>

      <div className="flex justify-center mb-8">
        <div className={cn(
          "w-28 h-28 rounded-3xl flex items-center justify-center shadow-inner relative overflow-hidden group-hover:scale-105 transition-transform duration-500",
          style.bgColor
        )}>
          {style.isVideo && lecture.thumbnailUrl && lecture.thumbnailUrl.startsWith("http") ? (
            <img 
              src={lecture.thumbnailUrl} 
              alt={lecture.title} 
              className="w-full h-full object-cover"
            />
          ) : (
            <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg", style.accentColor)}>
               {style.icon}
            </div>
          )}
          <div className={cn(
            "absolute bottom-0 left-0 right-0 py-1 text-[10px] font-black text-white text-center uppercase tracking-widest",
            style.accentColor, "opacity-90"
          )}>
            {style.label}
          </div>
        </div>
      </div>

      <div className="space-y-4 mb-10 min-h-[7rem] flex flex-col justify-center">
        <h3 className="text-xl font-bold text-on-surface leading-tight line-clamp-2 px-2">
          {lecture.title}
        </h3>
        
        <div className="flex items-center justify-center gap-3 mt-1">
          {dateParts && (
            <div className="flex items-center gap-3 bg-slate-50/80 px-4 py-2 rounded-2xl border border-slate-100 shadow-sm">
              <div className="flex flex-col items-center bg-white rounded-lg shadow-sm overflow-hidden border border-slate-100 min-w-[38px]">
                <div className={cn("w-full text-[8px] font-black text-white px-1.5 py-0.5 text-center uppercase", style.accentColor)}>
                  {dateParts.month}
                </div>
                <div className="text-sm font-bold text-slate-700 py-0.5">
                  {dateParts.day}
                </div>
              </div>
              <div className={cn("flex flex-col", isRTL ? "text-right" : "text-left")}>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider leading-none mb-1">
                  {t.analyzed}
                </span>
                <span className="text-xs font-bold text-slate-600">
                  {getFormattedDate()}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={cn("flex items-center gap-3", isRTL ? "flex-row" : "flex-row")}>
        <Link 
          href={isArchived ? "#" : `/lecture/${lecture.id}`}
          className={cn(
            "flex-1 py-3 px-6 rounded-2xl font-bold text-[15px] transition-all no-underline text-center shadow-lg active:scale-95 flex items-center justify-center",
            isArchived 
              ? "bg-slate-100 text-slate-500 cursor-default shadow-none border border-slate-200" 
              : "bg-surface text-on-surface border border-outline-variant shadow-sm hover:bg-surface-container-low"
          )}
        >
          {isArchived ? (
            <div className={cn("flex items-center gap-2", isRTL ? "flex-row" : "flex-row")}>
               <RotateCcw size={18} />
               <span>{t.restore}</span>
            </div>
          ) : t.view}
        </Link>

        <button 
          onClick={(e) => { e.preventDefault(); onDelete(); }}
          className="w-12 h-12 rounded-2xl bg-slate-50 text-slate-400 border border-slate-100 flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all cursor-pointer"
        >
          <Trash2 size={20} />
        </button>
      </div>
    </div>
  );
}
