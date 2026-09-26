// One-time contacts cleanup (26 Sep 2026), run on start: deletes test bookings and merges people who booked under
// several names or emails into one contact, by booking id. Safe to run again: bookings already cleaned are skipped.
// Also moves Triveni to her own email (26 Sep). Remove this file once the deploy log shows it ran.
import { allowStore, bookingsStore, enquiriesStore, ivStore } from "./data";
import { saveStore } from "./store";

const TEST_BOOKINGS = [
  "8012697b-2071-4ea3-8969-9f96af56779c", // test1
  "e98bc722-f4b1-4d1c-b892-02193ebbb162", // Test
  "6f4408dd-cb73-44b5-8423-f804174f65bd", // praneeth
  "44c26ae9-27f4-4d20-852c-c0a797405d2f", // Ofjehv
  "be8d5dca-ed47-4a8d-b902-4dd55394bebb", // praneeth Ga
];
const MERGES: { name: string; email: string; ids: string[] }[] = [
  {
    // Hareesh, Hareesh M and Hari
    name: "Hareesh M",
    email: "hareeshm.pro@gmail.com",
    ids: [
      "e7ba49fb-f7c8-42af-a304-377e62787a29",
      "31258e4b-c322-46d5-9564-2ca2248fa525",
      "8d52ec38-798e-4ecc-b673-32cdf6d2d756",
      "3fae929a-8d1e-4aaf-9b5f-ad7c32a6c2fe",
      "9273f35a-25a3-4450-b3cb-c5016f4c6444",
      "fe47057d-b104-4421-8e7b-75d8aeb973c9",
      "c45ae1e5-5740-46f8-8469-696838b8534a",
      "025b436c-21a0-47ae-b329-af6cfab1c702",
      "5a42a9bf-2784-4f0d-837c-022c7454de42",
    ],
  },
  {
    // Nagarjuna and Nagarjuna Reddy
    name: "Nagarjuna Reddy",
    email: "nagarjuna.reddy7407@gmail.com",
    ids: ["6f01cf21-5cbc-4b51-9f16-35b4948df1e4", "2c325248-7cfc-4bf7-8c27-dea215ce4148"],
  },
  {
    // Manoj under three emails
    name: "Manoj",
    email: "manojkuruba1999.it@gmail.com",
    ids: [
      "68ab2747-2264-48bd-a271-a0e41b6769a8",
      "782eb03e-51ed-4057-b97a-db5b4eab3c14",
      "f238ccb2-47c6-4301-a2b7-919847d6dbd0",
      "550afe73-e2ff-4292-9a3f-0575982cedef",
      "0865d250-00de-4e90-89b7-d84aa6d994e0",
    ],
  },
  {
    // sravani talluru / Sravani Talluru under two emails
    name: "Sravani Talluru",
    email: "sravanitalluru04@gmail.com",
    ids: [
      "13ec8d55-1163-4399-bed0-256b83360b2b",
      "37ef318d-8bb3-4406-9fb4-ec1a57a62907",
      "38e721ee-c3e0-4828-ae72-486f1db7cec4",
      "df9cf795-0f9b-4482-bb43-fe8dd05248c5",
      "f9c32435-cce4-4af4-b76c-387d2d35910d",
      "e4fb4833-210c-40cc-a3af-dfe83eb2c1be",
      "3ba035cc-70a1-405d-ae79-4c21b9fb14b4",
      "f9b1e514-81cd-4d7d-b30d-767eb6927353",
      "836b594e-ea5c-4767-9600-3d6a252cd81e",
      "4966e86d-46bf-4e59-b03a-8d180313ae55",
      "889e4af0-b112-4a63-b601-386b1f78ec1d",
      "330f5410-9f59-4226-8e11-63bba322219e",
      "50758047-d275-48cd-8796-799ff171181e",
      "6c6e8915-4e33-494e-8dfc-4fcdcdbee88e",
      "c1f568fa-b958-40b9-bafb-51baa1b09050",
      "80005b5f-9b29-43b4-b1fe-797cc3562301",
      "04b3c96b-0a69-4309-a508-16b6cddaefe6",
      "4eb5509f-b136-4903-8ab5-00bb239b425b",
      "74951604-51f2-4153-80b5-b0e6898266f7",
    ],
  },
];

// Triveni booked under gp.aws@hotmail.com, which is also used for other things: only her records move to her own email.
const TRIVENI_FROM = "gp.aws@hotmail.com";
const TRIVENI_TO = "trivenimarlapati446@gmail.com";
const isTriveni = (x: { name: string; email: string }) =>
  x.name.trim().toLowerCase() === "triveni" && x.email.trim().toLowerCase() === TRIVENI_FROM;
async function moveTriveni() {
  const bookings = bookingsStore.data.bookings.filter(isTriveni);
  const enquiries = enquiriesStore.data.enquiries.filter(isTriveni);
  // added once, with the move, so removing it from the allowlist later sticks
  const allow = bookings.length > 0 && !allowStore.data.emails.includes(TRIVENI_TO);
  for (const x of [...bookings, ...enquiries]) x.email = TRIVENI_TO;
  if (allow) allowStore.data.emails.push(TRIVENI_TO);
  if (bookings.length) await saveStore(bookingsStore);
  if (enquiries.length) await saveStore(enquiriesStore);
  if (allow && allowStore.ok) await saveStore(allowStore);
  if (bookings.length || enquiries.length || allow)
    console.log(
      "contacts cleanup: moved " + bookings.length + " booking(s) and " + enquiries.length + " enquiry(ies) to Triveni's email" +
        (allow ? ", added it to the allowlist" : ""),
    );
}

export async function cleanupContacts() {
  if (!bookingsStore.ok) return;
  await moveTriveni();
  const all = bookingsStore.data.bookings;
  const gone = all.filter((b) => TEST_BOOKINGS.includes(b.id));
  let merged = 0;
  for (const m of MERGES)
    for (const b of all)
      if (m.ids.includes(b.id) && (b.name !== m.name || b.email !== m.email)) {
        b.name = m.name;
        b.email = m.email;
        merged++;
      }
  if (!gone.length && !merged) return;
  bookingsStore.data.bookings = all.filter((b) => !gone.includes(b));
  for (const b of gone) delete ivStore.data.assign[b.id];
  await saveStore(bookingsStore);
  if (gone.length) await saveStore(ivStore);
  console.log("contacts cleanup: removed " + gone.length + " test booking(s), merged " + merged + " booking(s) into " + MERGES.length + " people");
}
