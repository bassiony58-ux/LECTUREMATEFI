import { Slide } from "@/lib/mockData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Download, Presentation, Edit2, Save, X, Check, Sparkles, Palette, ChevronDown, ChevronUp, Settings } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useState, useEffect, useMemo } from "react";
import { downloadSlidesPptx, SlideTheme, generateSlides } from "@/lib/aiService";
import { useLectures } from "@/hooks/useLectures";
import { useAuth } from "@/contexts/AuthContext";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { TextWithMath } from "./MathRenderer";
import { motion, AnimatePresence } from "framer-motion";

interface SlidesViewProps {
  slides: Slide[];
  title?: string;
  transcript?: string;
  summary?: string | string[];
  lectureId?: string;
}

export function SlidesView({ slides, title, transcript, summary, lectureId }: SlidesViewProps) {
  const { toast } = useToast();
  const { language } = useLanguage();
  const { user } = useAuth();
  const { updateLecture } = useLectures();

  const detectContentLanguage = useMemo(() => {
    if (!slides || slides.length === 0) return language;
    const allText = slides
      .map(slide => `${slide.title} ${Array.isArray(slide.content) ? slide.content.join(" ") : ""}`)
      .join(" ");
    const hasArabic = /[\u0600-\u06FF]/.test(allText);
    return hasArabic ? "ar" : language;
  }, [slides, language]);

  const contentDir = detectContentLanguage === "ar" ? "rtl" : "ltr";
  const contentTextAlign = detectContentLanguage === "ar" ? "right" : "left";
  const uiDir = language === "ar" ? "rtl" : "ltr";

  const [theme, setTheme] = useState<string>("clean_light");
  const [customColor, setCustomColor] = useState<string>("#4A90D9");
  const [isThemeOpen, setIsThemeOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [editingSlideId, setEditingSlideId] = useState<number | null>(null);
  const [editedSlides, setEditedSlides] = useState<Slide[]>(slides);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditedSlides(slides);
  }, [slides]);

  const defaultTitle = language === "ar" ? "شرائح المحاضرة" : "Lecture Slides";
  const displayTitle = title || defaultTitle;

  const t = {
    generatedSlides: language === "ar" ? "الشرائح المُنشأة" : "Generated Slides",
    downloadPPTX: language === "ar" ? "تحميل PowerPoint (.pptx)" : "Download PowerPoint (.pptx)",
    noSlides: language === "ar" ? "لا توجد شرائح متاحة" : "No slides available",
    slide: language === "ar" ? "شريحة" : "Slide",
    selectThemeLabel: language === "ar" ? "اختر نمط العرض الفاخر" : "Select Premium Style",
    saved: language === "ar" ? "تم الحفظ" : "Saved",
    savedDesc: language === "ar" ? "تم حفظ التغييرات بنجاح." : "Changes saved successfully.",
    themeCount: language === "ar" ? "اختر من بين 5 أنماط احترافية" : "Choose from 5 professional layout styles",
  };

  const themeConfig: Record<string, any> = {
    modern_dark: {
      label: language === "ar" ? "أسود ليلي" : "Midnight Black",
      defaultColor: "#FF1493", font: "Inter, sans-serif",
      colors: { bg: "bg-[#000000]", title: "text-[#FF1493]", text: "text-white" }
    },
    clean_light: {
      label: language === "ar" ? "أبيض ناصع" : "Pure White",
      defaultColor: "#DC2626", font: "Inter, sans-serif",
      colors: { bg: "bg-white", title: "text-[#DC2626]", text: "text-black" }
    },
    academic_blue: {
      label: language === "ar" ? "أزرق عميق" : "Deep Ocean",
      defaultColor: "#00FFFF", font: "Inter, sans-serif",
      colors: { bg: "bg-[#001529]", title: "text-[#00FFFF]", text: "text-white" }
    },
    midnight_gold: {
      label: language === "ar" ? "ذهبي فاخر" : "Luxury Gold",
      defaultColor: "#FFD700", font: "Inter, sans-serif",
      colors: { bg: "bg-[#000000]", title: "text-[#FFD700]", text: "text-white" }
    },
    vibrant_sunset: {
      label: language === "ar" ? "غروب برتقالي" : "Orange Sunset",
      defaultColor: "#FFFFFF", font: "Inter, sans-serif",
      colors: { bg: "bg-gradient-to-br from-red-600 to-orange-500", title: "text-white", text: "text-white" }
    },
    cyber_neon: {
      label: language === "ar" ? "سايبر نيون" : "Cyber Neon",
      defaultColor: "#00FF00", font: "Inter, sans-serif",
      colors: { bg: "bg-[#0a0a0a]", title: "text-[#00FF00]", text: "text-white" }
    },
    professional_gray: {
      label: language === "ar" ? "رمادي عملي" : "Soft Gray",
      defaultColor: "#DC2626", font: "Inter, sans-serif",
      colors: { bg: "bg-[#E5E7EB]", title: "text-[#DC2626]", text: "text-black" }
    },
    emerald_forest: {
      label: language === "ar" ? "غابة الزمرد" : "Emerald Forest",
      defaultColor: "#00FF00", font: "Inter, sans-serif",
      colors: { bg: "bg-[#001a00]", title: "text-[#00FF00]", text: "text-white" }
    },
  };

  const handleEditSlide = (slideId: number) => setEditingSlideId(slideId);
  const handleCancelEdit = () => { setEditingSlideId(null); setEditedSlides(slides); };
  
  const handleSaveSlide = async (slideId: number) => {
    if (!user?.uid || !lectureId) return;
    setIsSaving(true);
    try {
      await updateLecture({ lectureId, updates: { slides: editedSlides } });
      setEditingSlideId(null);
      toast({ title: t.saved, description: t.savedDesc });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally { setIsSaving(false); }
  };

  const handleUpdateSlideTitle = (slideId: number, newTitle: string) => {
    setEditedSlides(prev => prev.map(s => s.id === slideId ? { ...s, title: newTitle } : s));
  };

  const handleUpdateSlideContent = (slideId: number, newRawText: string) => {
    setEditedSlides(prev => prev.map(s => {
      if (s.id !== slideId) return s;
      const lines = newRawText.split("\n");
      
      // Type-aware updates
      if (s.type === "quote") return { ...s, quote: newRawText };
      if (s.type === "intro") return { ...s, subtitle: newRawText };
      if (s.type === "stats") {
        const newStats = lines.slice(0, 3).map(line => {
          const [value, ...labelParts] = line.split(":");
          return { value: value?.trim() || "", label: labelParts.join(":")?.trim() || "" };
        });
        return { ...s, stats: newStats };
      }
      return { ...s, content: lines };
    }));
  };

  const handleDownloadPPTX = async () => {
    if (editedSlides.length === 0) return;
    setIsDownloading(true);
    try {
      await downloadSlidesPptx(editedSlides, theme as SlideTheme, displayTitle, customColor);
      toast({ title: language === "ar" ? "تم التحميل" : "Downloaded", description: language === "ar" ? "تم تحميل ملف PowerPoint." : "PowerPoint file downloaded." });
    } catch (error: any) {
      toast({ title: "Error", description: error?.message, variant: "destructive" });
    } finally { setIsDownloading(false); }
  };

  return (
    <div className="space-y-8" dir={uiDir}>
      {/* Header Section */}
      <div className={cn("flex flex-col md:flex-row justify-between items-start md:items-center gap-6", uiDir === "rtl" && "md:flex-row-reverse")}>
        <div>
          <h3 className="text-3xl font-black flex items-center gap-3 tracking-tight">
            <div className="p-2 rounded-xl bg-primary/10">
              <Presentation className="w-8 h-8 text-primary" />
            </div>
            {t.generatedSlides}
          </h3>
          <p className="text-muted-foreground font-medium mt-1 ml-14">{displayTitle}</p>
        </div>
        <div className="flex gap-3">
          <Button onClick={handleDownloadPPTX} disabled={isDownloading || editedSlides.length === 0} size="lg" className="rounded-2xl shadow-xl shadow-primary/20 transition-all active:scale-95 px-8 h-14 font-black">
            <Download className={cn("w-5 h-5", uiDir === 'rtl' ? "ml-3" : "mr-3")} />
            {isDownloading ? "..." : t.downloadPPTX}
          </Button>
        </div>
      </div>

      {/* Premium Theme Selector */}
      <Collapsible open={isThemeOpen} onOpenChange={setIsThemeOpen} className="border-2 rounded-[2rem] bg-card shadow-xl overflow-hidden border-border/40 transition-all duration-500">
        <CollapsibleTrigger className="w-full flex items-center justify-between p-7 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white shadow-lg shadow-primary/20">
              <Palette className="w-6 h-6" />
            </div>
            <div className="text-left">
              <p className="font-black text-lg">{t.selectThemeLabel}</p>
              <p className="text-sm text-muted-foreground font-medium">{t.themeCount}</p>
            </div>
          </div>
          <div className="p-2 rounded-full bg-muted">
            {isThemeOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-10 border-t-2 border-border/40 bg-muted/5 space-y-10">
           <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
             {Object.entries(themeConfig).map(([key, conf]: [any, any]) => (
               <button key={key} onClick={() => setTheme(key)} className={cn("relative p-5 rounded-2xl border-2 transition-all group", theme === key ? "border-primary bg-primary/5 shadow-2xl scale-[1.05]" : "border-border hover:border-primary/40 hover:translate-y-[-4px]")}>
                 <div className={cn("aspect-video rounded-xl p-4 flex flex-col justify-between mb-4 border shadow-inner", conf.colors.bg)}>
                    <div className="w-full h-1.5 rounded-full" style={{ backgroundColor: theme === key ? customColor : "#eee" }} />
                    <div className="space-y-1.5">
                      <div className="w-3/4 h-1 bg-current opacity-20 rounded-full" />
                      <div className="w-1/2 h-1 bg-current opacity-10 rounded-full" />
                    </div>
                 </div>
                 <p className="text-[10px] font-black uppercase tracking-[0.15em] text-center truncate">{conf.label}</p>
                 {theme === key && <div className="absolute -top-2 -right-2 w-7 h-7 bg-primary text-white rounded-full shadow-lg flex items-center justify-center animate-in zoom-in-50"><Check className="w-4 h-4" /></div>}
               </button>
             ))}
           </div>
           <div className="flex items-center gap-8 p-6 bg-muted/40 rounded-3xl border-2 border-dashed border-border/60">
             <div className="p-4 rounded-2xl bg-white shadow-sm">
                <Palette className="w-8 h-8 text-primary" />
             </div>
             <div className="flex-1">
                <p className="text-lg font-black">{language === "ar" ? "تخصيص اللون" : "Brand Identity Color"}</p>
                <p className="text-sm text-muted-foreground font-medium">{language === "ar" ? "سيتم تطبيق هذا اللون على كافة العناصر التزيينية" : "Custom accent color for academic highlights"}</p>
             </div>
             <input type="color" value={customColor} onChange={e => setCustomColor(e.target.value)} className="w-24 h-16 rounded-2xl border-4 border-white cursor-pointer bg-transparent shadow-xl" />
           </div>
        </CollapsibleContent>
      </Collapsible>

      {/* High-End Slide Canvas Grid - Now 2 columns per row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {editedSlides.map((slide) => {
          const isEditing = editingSlideId === slide.id;
          const conf = themeConfig[theme] || themeConfig['clean'];
          return (
            <motion.div key={slide.id} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <Card className="overflow-hidden flex flex-col shadow-xl border-none group w-full rounded-[2rem] ring-1 ring-border/10">
                <div className={cn("aspect-[16/9] relative flex flex-col overflow-hidden transition-all duration-700", conf.colors.bg)} style={{ fontFamily: conf.font }}>
                  
                  {/* Premium Theme Visual Decorations */}
                  <div className="absolute top-0 left-0 right-0 h-1.5 transition-all duration-700 z-20" style={{ backgroundColor: customColor }} />
                  
                  <div className="absolute inset-0 flex flex-col justify-start items-stretch p-0 m-0 overflow-hidden">
                    {/* 1. RENDER HEADER (Only for content/structured slides) */}
                    {!isEditing && slide.type !== "intro" && slide.type !== "section" && (
                      <div className="shrink-0 pt-10 px-10 md:px-14 z-20">
                        <motion.h4 
                          layoutId={`title-${slide.id}`} 
                          className={cn("text-2xl md:text-3xl font-black mb-6 leading-tight tracking-tight border-b-2 pb-4", conf.colors.title)}
                          style={{ borderColor: `${customColor}40` }}
                        >
                          <TextWithMath text={slide.title} />
                        </motion.h4>
                      </div>
                    )}

                    {/* 2. RENDER EDITOR TITLE (If editing) */}
                    {isEditing && (
                      <div className="shrink-0 pt-10 px-10 md:px-14 z-20">
                        <Input value={slide.title} onChange={e => handleUpdateSlideTitle(slide.id, e.target.value)} className="text-2xl font-black bg-white/10 border-2 rounded-2xl h-14 px-6 w-full" />
                      </div>
                    )}

                    {/* 3. BODY SECTION (Centered Content) */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar relative px-10 md:px-14 flex flex-col justify-center min-h-0">
                      {isEditing ? (
                        <div className="mt-6 flex-1">
                          <Textarea 
                            value={
                              slide.type === "quote" ? (slide.quote || "") :
                              slide.type === "intro" ? (slide.subtitle || "") :
                              slide.type === "stats" ? (slide.stats || []).map(st => `${st.value}: ${st.label}`).join("\n") :
                              slide.content.join("\n")
                            } 
                            onChange={e => handleUpdateSlideContent(slide.id, e.target.value)} 
                            className="w-full h-full min-h-[150px] resize-none bg-white/10 border-2 rounded-2xl font-medium text-xl p-6 leading-relaxed" 
                          />
                        </div>
                      ) : (
                        <div className="w-full">
                          {/* INTRO / SECTION TYPE (Full Slide Center) */}
                          {(slide.type === "intro" || slide.type === "section") && (
                            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center justify-center h-full text-center px-10">
                              {!slide.content?.length && slide.type === "section" && (
                                <h3 className={cn("text-3xl md:text-5xl font-black", conf.colors.title)}>
                                  <TextWithMath text={slide.title} />
                                </h3>
                              )}
                              {slide.subtitle && (
                                <p className={cn("text-xl md:text-2xl font-bold opacity-70", conf.colors.text)}>
                                  <TextWithMath text={slide.subtitle} />
                                </p>
                              )}
                            </motion.div>
                          )}

                          {/* 2. QUOTE TYPE */}
                          {slide.type === "quote" && slide.quote && (
                            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="py-10">
                              <p className={cn("text-2xl md:text-4xl font-black italic leading-tight text-center px-10", conf.colors.text)} dir={contentDir}>
                                <span className="text-primary text-6xl block mb-4 opacity-50">"</span>
                                <TextWithMath text={slide.quote} />
                                <span className="text-primary text-6xl block mt-4 opacity-50">"</span>
                              </p>
                            </motion.div>
                          )}

                          {/* 3. STATS TYPE */}
                          {slide.type === "stats" && slide.stats && (
                            <div className="grid grid-cols-3 gap-6 py-6">
                              {slide.stats.slice(0, 3).map((stat, i) => (
                                <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }} className="bg-white/5 rounded-3xl p-6 border-2 border-white/10 flex flex-col items-center justify-center text-center shadow-lg">
                                  <span className="text-3xl md:text-5xl font-black text-primary mb-2 truncate w-full">{stat.value}</span>
                                  <span className={cn("text-xs md:text-sm font-bold uppercase tracking-widest opacity-60", conf.colors.text)}>{stat.label}</span>
                                </motion.div>
                              ))}
                            </div>
                          )}

                          {/* 4. COMPARISON TYPE */}
                          {slide.type === "comparison" && (
                            <div className="grid grid-cols-2 gap-10 py-6 h-full items-start">
                              {/* Left Side */}
                              <div className="space-y-6 flex flex-col">
                                <h5 className="text-xl font-black uppercase tracking-widest text-primary border-b-2 border-primary/20 pb-2">{slide.left_label || "Side A"}</h5>
                                <ul className="space-y-4">
                                  {(slide.left_points || []).map((pt, i) => (
                                    <li key={i} className={cn("flex items-start gap-4 text-base md:text-lg font-medium", conf.colors.text)}>
                                      <div className="w-2 h-2 rounded-full mt-2.5 shrink-0" style={{ backgroundColor: customColor }} />
                                      <TextWithMath text={pt} />
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              {/* Right Side */}
                              <div className="space-y-6 flex flex-col">
                                <h5 className="text-xl font-black uppercase tracking-widest text-primary border-b-2 border-primary/20 pb-2">{slide.right_label || "Side B"}</h5>
                                <ul className="space-y-4">
                                  {(slide.right_points || []).map((pt, i) => (
                                    <li key={i} className={cn("flex items-start gap-4 text-base md:text-lg font-medium", conf.colors.text)}>
                                      <div className="w-2 h-2 rounded-full mt-2.5 shrink-0" style={{ backgroundColor: customColor }} />
                                      <TextWithMath text={pt} />
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}

                          {/* 5. DEFAULT CONTENT / SUMMARY TYPE */}
                          {(slide.type === "content" || slide.type === "summary" || !slide.type) && slide.content?.length > 0 && (
                            <ul 
                              className={cn("font-medium m-0 p-0", conf.colors.text)} 
                              dir={contentDir} 
                              style={{ 
                                marginTop: 0, 
                                paddingTop: 0,
                                paddingBottom: slide.content.filter(b => b.trim()).length > 0 ? '20px' : '0'
                              }}
                            >
                              {slide.content.filter(item => item.trim()).map((item, i) => {
                                const totalChars = slide.content.join("").length;
                                const numBullets = slide.content.length;
                                
                                // EXTREMELY SPARSE (up to 4 items)
                                const isSparse = numBullets <= 4 && totalChars < 250;
                                // MEDIUM (up to 8 items)
                                const isMedium = numBullets <= 8 && totalChars < 600;

                                const fontSize = isSparse ? 'text-2xl md:text-3xl' : isMedium ? 'text-xl md:text-2xl' : 'text-lg md:text-xl';
                                const gapSize = isSparse ? 'gap-8' : isMedium ? 'gap-6' : 'gap-4';
                                const bulletSize = isSparse ? 'w-4 h-4' : isMedium ? 'w-3 h-3' : 'w-2.5 h-2.5';
                                const leading = isSparse ? 'leading-relaxed' : isMedium ? 'leading-relaxed' : 'leading-normal';
                                const dotMargin = isSparse ? 'mt-4' : isMedium ? 'mt-3' : 'mt-2.5';
                                const itemPadding = isSparse ? 'pt-10' : isMedium ? 'pt-8' : 'pt-4';

                                return (
                                  <motion.li 
                                    key={i} 
                                    initial={{ opacity: 0, x: contentDir === 'rtl' ? 10 : -10 }}
                                    whileInView={{ opacity: 1, x: 0 }}
                                    transition={{ delay: i * 0.02 }}
                                    className={cn("flex items-start", gapSize)} 
                                    style={{ textAlign: contentTextAlign, marginTop: 0, paddingTop: itemPadding }}
                                  >
                                    <div className={cn("rounded-full shrink-0 shadow-sm", bulletSize, dotMargin)} style={{ backgroundColor: customColor }} />
                                    <div className="flex-1 min-w-0">
                                      <TextWithMath text={item} className={cn(fontSize, leading, conf.colors.text)} />
                                    </div>
                                  </motion.li>
                                );
                              })}
                            </ul>
                          )}
                          {/* 6. FALLBACK FOR EMPTY SLIDES */}
                          {(!slide.type || slide.type === "content") && (!slide.content || slide.content.length === 0) && !slide.subtitle && !slide.quote && (
                            <div className="text-center opacity-20">
                              <Presentation className="w-16 h-16 mx-auto mb-4" />
                              <p className="text-sm font-bold uppercase tracking-widest">{language === "ar" ? "لا يوجد محتوى إضافي" : "No additional content"}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Footer - Branding Section (Pinned to bottom with solid mask) */}
                    <div className={cn("shrink-0 pt-4 pb-6 px-10 md:px-14 z-30 border-t border-white/10", conf.colors.bg)}>
                      <div className="flex justify-between items-center text-[10px] md:text-[11px] font-black uppercase tracking-[0.3em] opacity-40 transition-all group-hover:opacity-100 mix-blend-difference text-white">
                        <span className="flex items-center gap-2 font-bold"><Sparkles className="w-3.5 h-3.5 text-primary" /> LECTUREMATE AI</span>
                        <span className="opacity-60">SLIDE {slide.id} — {theme.toUpperCase()}</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Editor Toolbar */}
                <CardContent className="p-6 bg-muted/40 border-t-2 border-border/40 flex justify-between items-center px-10">
                  <div className="flex items-center gap-4">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: customColor }} />
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Draft Instance #{slide.id}</span>
                  </div>
                  <div className="flex gap-3">
                    {isEditing ? (
                      <>
                        <Button size="lg" variant="default" onClick={() => handleSaveSlide(slide.id)} disabled={isSaving} className="rounded-2xl shadow-xl px-6 font-black h-12 gap-3"><Save className="w-4 h-4" /> SAVE</Button>
                        <Button size="lg" variant="ghost" onClick={handleCancelEdit} className="rounded-2xl h-12 font-black">CANCEL</Button>
                      </>
                    ) : (
                      <Button size="lg" variant="outline" onClick={() => handleEditSlide(slide.id)} className="rounded-2xl border-2 hover:bg-primary hover:text-white hover:border-primary opacity-0 group-hover:opacity-100 transition-all h-12 font-black gap-3"><Edit2 className="w-4 h-4" /> EDIT SLIDE</Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
