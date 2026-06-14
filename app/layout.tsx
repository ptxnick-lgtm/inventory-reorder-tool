import React from "react";

export const metadata = {
  title: "Inventory Reorder Tool",
  description: "Upload an inventory export and get a sorted reorder list.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`
          html { color-scheme: dark; }
          ::selection { background: #5b9bff; color: #0b1220; }
          input::placeholder { color: #6b7480; }
          input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.8); }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#0f1217",
          color: "#e6e8eb",
        }}
      >
        {children}
      </body>
    </html>
  );
}
