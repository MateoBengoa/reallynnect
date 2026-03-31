import type { Metadata } from "next";
import { Onest } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const onest = Onest({
  subsets: ["latin"],
  variable: "--font-onest",
});

export const metadata: Metadata = {
  title: "LinkedIn Automation",
  description: "Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={onest.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-[var(--bg)] font-sans antialiased text-[var(--text)] transition-colors duration-200">
        <Script id="dashboard-theme-init" strategy="beforeInteractive">
          {`(function(){try{var t=localStorage.getItem("dashboard-theme");if(t==="light")document.documentElement.setAttribute("data-theme","light");}catch(e){}})();`}
        </Script>
        {children}
      </body>
    </html>
  );
}
