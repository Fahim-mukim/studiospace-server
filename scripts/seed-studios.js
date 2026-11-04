import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const studioCategories = {
  "photo-studios": "Photo Studios",
  "sound-stages": "Sound Stages",
  "podcast-rooms": "Podcast Rooms",
  "music-suites": "Music Suites",
  "art-workshops": "Art Workshops",
};

const seedStudios = [
  {
    seedId: "seed-daylight-loft",
    title: "Daylight Loft Studio",
    categorySlug: "photo-studios",
    hourlyRate: 95,
    securityDeposit: 150,
    capacity: 8,
    location: "Brooklyn, New York",
    image: "https://images.unsplash.com/photo-1497366216548-37526070297c?q=80&w=2069&auto=format&fit=crop",
    imageAlt: "Bright loft studio with large windows",
    amenities: ["Natural light", "Cyc wall", "Changing area", "Parking nearby"],
    overview: "A stunning daylight loft with floor-to-ceiling windows perfect for portrait photography, fashion shoots, and creative content creation. The space features a clean white cyc wall and abundant natural light throughout the day.",
  },
  {
    seedId: "seed-sonic-wave",
    title: "Sonic Wave Recording Studio",
    categorySlug: "sound-stages",
    hourlyRate: 120,
    securityDeposit: 200,
    capacity: 6,
    location: "Nashville, Tennessee",
    image: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?q=80&w=2070&auto=format&fit=crop",
    imageAlt: "Professional recording studio with sound equipment",
    amenities: ["Sound treated", "Mixing console", "Microphones included", "Engineer available"],
    overview: "Professional-grade recording studio with top-of-the-line equipment. Perfect for musicians, podcasters, and voice-over artists. The acoustically treated space ensures pristine audio quality for all your recording needs.",
  },
  {
    seedId: "seed-voice-room",
    title: "The Voice Room Podcast Studio",
    categorySlug: "podcast-rooms",
    hourlyRate: 65,
    securityDeposit: 100,
    capacity: 4,
    location: "Austin, Texas",
    image: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?q=80&w=2070&auto=format&fit=crop",
    imageAlt: "Cozy podcast studio with microphones",
    amenities: ["4 microphones", "Soundproof booth", "Recording software", "Comfortable seating"],
    overview: "Intimate podcast studio designed specifically for recording conversations and interviews. Equipped with professional microphones, soundproofing, and easy-to-use recording equipment. Ideal for podcasts, interviews, and voice content.",
  },
  {
    seedId: "seed-groove-lab",
    title: "Groove Lab Music Suite",
    categorySlug: "music-suites",
    hourlyRate: 85,
    securityDeposit: 130,
    capacity: 5,
    location: "Los Angeles, California",
    image: "https://images.unsplash.com/photo-1511379938547-c1f69419868d?q=80&w=2070&auto=format&fit=crop",
    imageAlt: "Music studio with instruments and equipment",
    amenities: ["Instruments provided", "Amp collection", "DAW workstation", "Drum kit"],
    overview: "Fully equipped music production suite perfect for jamming, recording, and producing. Comes with a variety of instruments, amplifiers, and a professional DAW workstation. Great for solo artists and small bands.",
  },
  {
    seedId: "seed-creative-hub",
    title: "Creative Hub Art Workshop",
    categorySlug: "art-workshops",
    hourlyRate: 55,
    securityDeposit: 80,
    capacity: 12,
    location: "Portland, Oregon",
    image: "https://images.unsplash.com/photo-1461344577544-4e5dc9487184?q=80&w=2070&auto=format&fit=crop",
    imageAlt: "Art workshop with tables and supplies",
    amenities: ["Work tables", "Easels provided", "Storage space", "Ventilation system"],
    overview: "Spacious art workshop perfect for painting, drawing, sculpting, and other creative projects. Well-lit space with ample work surfaces and storage. Bring your supplies or use ours - ideal for classes, workshops, and individual artists.",
  },
  {
    seedId: "seed-urban-shoot",
    title: "Urban Shoot Photography Studio",
    categorySlug: "photo-studios",
    hourlyRate: 110,
    securityDeposit: 175,
    capacity: 10,
    location: "Chicago, Illinois",
    image: "https://images.unsplash.com/photo-1604014237800-1c9102c219da?q=80&w=2052&auto=format&fit=crop",
    imageAlt: "Modern photography studio with props",
    amenities: ["Multiple backdrops", "Professional lighting", "Props collection", "Makeup station"],
    overview: "Modern photography studio with versatile shooting areas and professional equipment. Features multiple backdrop options, studio lighting, and a curated props collection. Perfect for product photography, fashion shoots, and portraits.",
  },
];

function createStudioSlug(title, id) {
  const titleSlug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${titleSlug || "studio"}-${id.toHexString()}`;
}

async function seed() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "studiospace";
  
  if (!uri) {
    console.error("MONGODB_URI not configured");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection("studios");
    
    let created = 0;
    let skipped = 0;
    
    for (const seedData of seedStudios) {
      const existing = await collection.findOne({ seedId: seedData.seedId });
      if (existing) {
        skipped++;
        continue;
      }
      
      const id = new ObjectId();
      const now = new Date();
      const slug = createStudioSlug(seedData.title, id);
      
      const studio = {
        _id: id,
        title: seedData.title,
        categorySlug: seedData.categorySlug,
        category: studioCategories[seedData.categorySlug],
        hourlyRate: seedData.hourlyRate,
        securityDeposit: seedData.securityDeposit,
        capacity: seedData.capacity,
        location: seedData.location,
        image: seedData.image,
        imageAlt: seedData.imageAlt,
        amenities: seedData.amenities,
        overview: seedData.overview,
        slug,
        ownerId: `seed-owner-${seedData.seedId}`,
        ownerEmail: `seed.${seedData.seedId}@studiospace.demo`,
        ownerName: "StudioSpace Demo Host",
        host: {
          name: "StudioSpace Demo Host",
        },
        createdAt: now,
        updatedAt: now,
        reviewCount: 0,
        seedId: seedData.seedId,
        isSeed: true,
      };
      
      await collection.insertOne(studio);
      created++;
      console.log(`Created: ${seedData.title} (${slug})`);
    }
    
    console.log(`\nSeeding complete. Created: ${created}, Skipped (already exist): ${skipped}`);
  } finally {
    await client.close();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
