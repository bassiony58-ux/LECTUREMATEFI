import { useState, useEffect, useRef, useMemo } from "react";
import { Formula } from "@/lib/mockData";
import { Copy, Sigma, BookOpen, Info, Maximize2, X, Download, MoreVertical, Star, Link as LinkIcon, ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { KaTeXMath, TextWithMath } from "./MathRenderer";

interface FormulasViewProps {
    formulas: any[];
    lectureTitle?: string;
}

export function FormulasView({ formulas, lectureTitle = "General Knowledge" }: FormulasViewProps) {
    const { toast } = useToast();
    const { language } = useLanguage();
    const [selectedFormula, setSelectedFormula] = useState<any | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);

    const t = {
        title: language === "ar" ? "المعادلات الرياضية" : "Mathematical Formulas",
        subtitle: language === "ar" ? "مستخرجة من" : "Extracted from",
        emptyTitle: language === "ar" ? "لا توجد قوانين أو معادلات" : "No Formulas Found",
        emptyDesc: language === "ar" ? "لم يتم العثور على قوانين في هذه المحاضرة." : "No mathematical formulas found in this lecture.",
        copySuccess: language === "ar" ? "تم نسخ المعادلة بنجاح" : "Formula Copied",
        copySuccessDesc: language === "ar" ? "تم نسخ رمز LaTeX إلى الحافظة." : "LaTeX code copied to clipboard.",
    };



    const filteredFormulas = useMemo(() => {
        let result = formulas;
        if (searchQuery) {
            result = result.filter(f => {
                const text = `${f.name || ""} ${f.description || ""}`.toLowerCase();
                return text.includes(searchQuery.toLowerCase());
            });
        }
        return result;
    }, [formulas, searchQuery]);

    const copyToClipboard = (text: string, e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        toast({ title: t.copySuccess, description: t.copySuccessDesc, duration: 3000 });
    };

    const handleExportPDF = async () => {
        try {
            const hasArabic = /[\u0600-\u06FF]/.test(formulas.map(f => f.name + f.description).join('') || lectureTitle);
            const dir = hasArabic ? "rtl" : "ltr";
            const primaryColor = "#F05A22";
            
            toast({ title: language === "ar" ? "جاري تحضير ملف PDF..." : "Preparing PDF...", description: language === "ar" ? "يرجى الانتظار قليلاً" : "Please wait a moment" });
            
            // Import libraries and requirements
            const { jsPDF } = await import("jspdf");
            const html2canvas = (await import("html2canvas")).default;
            const katex = (await import("katex")).default;
            const { sanitizeLatex } = await import("./MathRenderer");

            const htmlContent = `
                <html>
                <head>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=IBM+Plex+Sans+Arabic:wght@400;700&display=swap" rel="stylesheet">
                    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
                    <style>
                        body { 
                            font-family: 'Inter', 'IBM Plex Sans Arabic', sans-serif; 
                            margin: 0; 
                            padding: 40px; 
                            background: white; 
                            direction: ${dir}; 
                        }
                        .header {
                            text-align: center;
                            margin-bottom: 40px;
                            padding-bottom: 20px;
                            border-bottom: 2px solid ${primaryColor};
                        }
                        .formula-card {
                            page-break-inside: avoid;
                            margin-bottom: 30px;
                            padding: 25px;
                            border: 1px solid #e2e8f0;
                            border-radius: 16px;
                            background: #f8fafc;
                        }
                        .formula-name {
                            font-size: 20px;
                            font-weight: 700;
                            color: #0f172a;
                            margin: 0 0 15px 0;
                        }
                        .formula-math {
                            padding: 20px;
                            background: white;
                            border: 1px solid #f1f5f9;
                            border-radius: 12px;
                            text-align: center;
                            margin-bottom: 15px;
                            font-size: 22px;
                        }
                        .formula-desc {
                            font-size: 14px;
                            color: #475569;
                            line-height: 1.6;
                            margin: 0;
                        }
                        .category-tag {
                            display: inline-block;
                            padding: 4px 10px;
                            background: ${primaryColor}15;
                            color: ${primaryColor};
                            border-radius: 6px;
                            font-size: 10px;
                            font-weight: 800;
                            text-transform: uppercase;
                            margin-bottom: 10px;
                        }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <h1 style="color: ${primaryColor}; margin: 0; font-size: 32px;">${t.title}</h1>
                        <p style="color: #64748b; margin: 10px 0 0 0;">${lectureTitle} • ${new Date().toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}</p>
                    </div>
                    ${formulas.map(f => {
                        const sanitized = sanitizeLatex(f.formula || "");
                        let renderedMath = "";
                        try {
                            renderedMath = katex.renderToString(sanitized, { displayMode: true, throwOnError: false });
                        } catch (e) {
                            renderedMath = f.formula;
                        }
                        
                        return `
                            <div class="formula-card">
                                <span class="category-tag">${f.category || (language === 'ar' ? 'أخرى' : 'Other')}</span>
                                <h3 class="formula-name">${f.name}</h3>
                                <div class="formula-math">${renderedMath}</div>
                                <p class="formula-desc">${f.description}</p>
                            </div>
                        `;
                    }).join('')}
                </body>
                </html>
            `;

            const container = document.createElement("div");
            container.innerHTML = htmlContent;
            container.style.position = "absolute";
            container.style.left = "-9999px";
            container.style.width = "210mm"; // A4 Width
            document.body.appendChild(container);

            // Wait for fonts and images to load
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const canvas = await html2canvas(container, { 
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: "#ffffff"
            });
            document.body.removeChild(container);

            const imgData = canvas.toDataURL("image/jpeg", 0.95);
            const pdf = new jsPDF("p", "mm", "a4");
            const pageWidth = 210;
            const pageHeight = 297;
            const imgWidth = pageWidth;
            const imgHeight = (canvas.height * pageWidth) / canvas.width;
            
            let heightLeft = imgHeight;
            let position = 0;

            pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;

            while (heightLeft > 0) {
                position = heightLeft - imgHeight;
                pdf.addPage();
                pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
                heightLeft -= pageHeight;
            }

            pdf.save(`${lectureTitle.replace(/[^a-z0-9]/gi, '_')}_formulas.pdf`);
            toast({ title: language === "ar" ? "تمت عملية التصدير بنجاح" : "Export Successful" });
        } catch (error) {
            console.error("PDF Export Error:", error);
            toast({ title: language === "ar" ? "خطأ في التصدير" : "Export Failed", variant: "destructive" });
        }
    };

    if (!formulas || formulas.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center space-y-6">
                <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center">
                    <Sigma className="w-10 h-10 text-primary" />
                </div>
                <div className="max-w-md space-y-2">
                    <h3 className="text-2xl font-bold">{t.emptyTitle}</h3>
                    <p className="text-slate-500">{t.emptyDesc}</p>
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className="max-w-7xl mx-auto py-8 font-display animate-in fade-in duration-500">
            {/* Header Section */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
                <div className="space-y-2">
                    <h1 className="text-4xl lg:text-5xl font-black tracking-tight text-slate-900">
                        {t.title}
                    </h1>
                    <p className="text-lg text-slate-600 max-w-2xl">
                        {t.subtitle} <span className="text-primary font-semibold italic">"{lectureTitle}"</span>
                    </p>
                </div>
                <div className="flex gap-2">
                    <button 
                        onClick={handleExportPDF}
                        className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-white rounded-xl font-bold shadow-lg shadow-primary/20 hover:brightness-110 active:scale-95 transition-all"
                    >
                        <Download className="w-5 h-5" />
                        {language === "ar" ? "تصدير PDF" : "Export PDF"}
                    </button>
                    <button title={language === "ar" ? "المزيد من الخيارات" : "More options"} className="flex items-center justify-center p-3 border border-slate-200 rounded-xl hover:bg-slate-100 transition-colors bg-white">
                        <MoreVertical className="w-5 h-5 text-slate-600" />
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            <div className="flex flex-col sm:flex-row items-center justify-end gap-4 mb-10">
                <div className="relative w-full sm:w-72 md:w-80 shrink-0">
                    <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-slate-400">
                        <Search className="w-5 h-5" />
                    </div>
                    <input 
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={language === "ar" ? "البحث في القوانين..." : "Search formulas..."}
                        className="block w-full pl-10 pr-4 py-3 border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-primary focus:border-transparent text-sm placeholder-slate-400 font-medium"
                    />
                </div>
            </div>

            {/* Formulas Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                {filteredFormulas.map((formula, idx) => (
                    <FormulaCard 
                        key={formula.id || idx}
                        formula={formula}
                        index={idx}
                        language={language}
                        onClick={() => setSelectedFormula(formula)}
                        onCopy={copyToClipboard}
                    />
                ))}

                {/* AI Suggested Summary Card */}
                {filteredFormulas.length > 0 && !searchQuery && (
                    <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col justify-center rounded-2xl border border-primary/20 bg-primary/5 p-8 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden"
                    >
                        <div className="absolute -top-4 -right-4 p-4 opacity-50 dark:opacity-20">
                            <span className="material-symbols-outlined text-primary text-[100px] select-none">auto_awesome</span>
                        </div>
                        <div className="flex items-start justify-between mb-6 relative z-10">
                            <span className="px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-primary bg-primary/20 rounded-md">{language === "ar" ? "نصيحة ذكية" : "AI Suggested Insight"}</span>
                            <span className="material-symbols-outlined text-primary">psychology</span>
                        </div>
                        <div className="space-y-4 relative z-10">
                            <h3 className="font-bold text-2xl text-slate-900">{language === "ar" ? "نصيحة دراسية: أساسيات الرياضيات" : "Study Tip: Foundational Math"}</h3>
                            <p className="text-base text-slate-600 italic leading-relaxed">
                                {language === "ar" 
                                  ? "\"هذه المعادلات تشكّل الأساس الرياضي لهذا الموضوع. تذكّر أن حفظ الصيغة أقل أهمية من فهم المتغيرات وكيف ترتبط بالمفاهيم الفعلية في المحاضرة.\""
                                  : "\"These formulas form the mathematical foundation for this topic. Remember that memorizing the syntax is less important than understanding the variables and how they map to the physical or logical concepts described in the lecture.\""}
                            </p>
                            <button className="flex items-center gap-2 text-primary font-bold text-sm mt-4 hover:underline">
                                <LinkIcon className="w-4 h-4" />
                                {language === "ar" ? "بحث عن أمثلة تطبيقية" : "Search related practice problems"}
                            </button>
                        </div>
                    </motion.div>
                )}
            </div>

            {filteredFormulas.length === 0 && (
                <div className="py-20 text-center text-slate-500 font-medium">
                    {language === "ar" ? "لم يتم العثور على قوانين تطابق بحثك." : "No formulas match your search criteria."}
                </div>
            )}



            {/* Lightbox / Zoom Dialog */}
            <AnimatePresence>
                {selectedFormula && (
                    <Dialog open={!!selectedFormula} onOpenChange={(open) => !open && setSelectedFormula(null)}>
                        <DialogContent className="max-w-[95vw] sm:max-w-3xl lg:max-w-4xl xl:max-w-5xl border-2 overflow-hidden p-0 gap-0">
                            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-purple-500/5 -z-10" />

                            <div className="p-6 border-b bg-card/50 backdrop-blur-sm shadow-sm flex items-start justify-between">
                                <div className="space-y-1">
                                    <h2 className="text-2xl font-bold flex items-center gap-2">
                                        <Sigma className="w-6 h-6 text-primary" />
                                        {selectedFormula.name}
                                    </h2>
                                </div>
                            </div>

                            <div className="p-4 sm:p-10 bg-black/5 dark:bg-black/20 relative group">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 hover:bg-background"
                                    onClick={(e) => copyToClipboard(selectedFormula.formula, e)}
                                >
                                    <Copy className="w-5 h-5 text-muted-foreground" />
                                </Button>
                                <div className="overflow-x-auto w-full pb-2 scrollbar-thin scrollbar-thumb-primary/20 scrollbar-track-transparent flex justify-center">
                                    <KaTeXMath formula={selectedFormula.formula} displayMode={true} />
                                </div>
                            </div>

                            <div className="p-8 bg-card space-y-6">
                                <div className="flex items-start gap-3">
                                    <Info className="w-6 h-6 text-primary flex-shrink-0 mt-0.5" />
                                    <div className="space-y-3">
                                        <h4 className="font-bold text-lg text-foreground">{language === "ar" ? "الشرح والتفاصيل" : "Explanation"}</h4>
                                        <div className="text-base text-slate-600 dark:text-slate-400 leading-relaxed font-medium">
                                            <TextWithMath text={selectedFormula.description} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </DialogContent>
                    </Dialog>
                )}
            </AnimatePresence>
        </div>
    );
}

function FormulaCard({
    formula,
    index,
    language,
    onCopy,
    onClick
}: {
    formula: any;
    index: number;
    language: string;
    onCopy: (text: string, e: React.MouseEvent) => void;
    onClick: () => void;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05, duration: 0.4 }}
            className="flex flex-col rounded-[24px] border border-[#F1F5F9] bg-white p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_20px_40px_rgb(0,0,0,0.08)] transition-all duration-500 group cursor-pointer h-full relative overflow-hidden"
            onClick={onClick}
        >
            <div className="flex items-start justify-between mb-4">
                <span className="px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-primary bg-primary/10 rounded-md">
                    {language === "ar" ? "معادلة" : "Equation"}
                </span>
                <button 
                    title={language === "ar" ? "إضافة للمفضلة" : "Add to favorites"}
                    className="text-slate-200 hover:text-yellow-400 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                >
                    <Star className="w-5 h-5 fill-current" />
                </button>
            </div>
            
            <div className="flex items-center justify-center py-10 px-4 bg-[#F8FAFC] rounded-2xl mb-6 border border-[#F1F5F9] relative overflow-hidden group/math">
                <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 opacity-0 group-hover/math:opacity-100 transition-opacity z-10 hover:bg-slate-200 h-8 w-8"
                    onClick={(e) => onCopy(formula.formula, e)}
                    title="Copy LaTeX"
                >
                    <Copy className="w-4 h-4 text-slate-400" />
                </Button>
                <div className="overflow-x-auto w-full text-center pb-2 no-scrollbar px-4 flex justify-center">
                    <KaTeXMath formula={formula.formula} />
                </div>
            </div>

            <div className="space-y-4 flex-1 flex flex-col">
                <h3 className="font-bold text-xl text-slate-900 line-clamp-2">{formula.name}</h3>
                <p className="text-sm text-slate-500 line-clamp-3 leading-relaxed font-medium">
                    <TextWithMath text={formula.description} />
                </p>
                
                {/* Dynamically render variables if backend provided them */}
                {formula.variables && Array.isArray(formula.variables) && formula.variables.length > 0 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-3 pt-4 mt-auto border-t border-slate-100">
                        {formula.variables.map((v: any, i: number) => (
                            <div key={i} className="flex items-center gap-2">
                                <span className="text-xs font-mono bg-[#FFF7ED] px-1.5 py-0.5 rounded text-primary border border-primary/10">
                                    <KaTeXMath formula={v.symbol} displayMode={false} />
                                </span>
                                <span className="text-xs text-slate-400 font-medium">{v.meaning}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </motion.div>
    );
}

