import { useEffect } from "react";

// Gapchi olib tashlandi: UzDTM'dagi Speaking bo'limi Sado AI ga (/speaking/) yo'naltiriladi
function Speaking() {
  useEffect(() => {
    window.location.replace("/speaking/?v=7");
  }, []);
  return null;
}

export { Speaking };
export default Speaking;
