import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "로지 제작 브리핑",
  description: "촬영해 둔 순간부터 완성한 릴스까지, 어디서든 제작 흐름을 확인해요.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: [{url:"/icons/app-180.png",sizes:"180x180",type:"image/png"}],
  },
};

export const viewport: Viewport = {width:"device-width",initialScale:1,viewportFit:"cover",themeColor:"#f7f8fa"};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head><meta name="apple-mobile-web-app-capable" content="yes"/><meta name="mobile-web-app-capable" content="yes"/><meta name="apple-mobile-web-app-title" content="로지 브리핑"/><meta name="apple-mobile-web-app-status-bar-style" content="default"/></head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
