import fetch from 'node-fetch';

async function test() {
  try {
    console.log("Sending request...");
    const res = await fetch("http://localhost:5000/api/ai/generate-document", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "عايزك تعملى كتاب يكون اول صفحه كده ويكون فيه شرح لكل شابتر بنفس ال templet بكل حاجه" })
    });
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response:", text);
  } catch (e) {
    console.error("Error:", e);
  }
}

test();
