import React, { useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigError } from "./lib/supabase";

const storageBucket = "memory-media";
const signedUrlLifetime = 60 * 60 * 24;
const expectedAnniversary = import.meta.env.VITE_ANNIVERSARY_DATE;
const appConfigError = supabaseConfigError || (!expectedAnniversary
  ? "Set VITE_ANNIVERSARY_DATE in .env to the anniversary date, then restart Vite."
  : null);

function formatDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return {
    day: date.toLocaleDateString("en-US", { day: "2-digit" }),
    month: date.toLocaleDateString("en-US", { month: "short" }),
    year: date.toLocaleDateString("en-US", { year: "numeric" }),
    weekday: date.toLocaleDateString("en-US", { weekday: "long" }),
    long: date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  };
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const fields = ["message", "code", "details", "hint"]
      .filter(field => typeof error[field] === "string" && error[field])
      .map(field => `${field}: ${error[field]}`);
    return fields.length > 0 ? fields.join(" — ") : JSON.stringify(error);
  }
  return String(error);
}

async function fetchGalleryMemories(galleryId) {
  const { data, error } = await supabase
    .from("memories")
    .select("id, gallery_id, memory_date, title, location, note, media(id, storage_path, media_type, original_name, sort_order)")
    .eq("gallery_id", galleryId)
    .order("memory_date", { ascending: false });

  if (error) throw error;

  const paths = (data ?? []).flatMap(memory => (memory.media ?? []).map(media => media.storage_path));
  let urlsByPath = new Map();

  if (paths.length > 0) {
    const { data: signedUrls, error: signedUrlError } = await supabase
      .storage
      .from(storageBucket)
      .createSignedUrls(paths, signedUrlLifetime);

    if (signedUrlError) throw signedUrlError;
    urlsByPath = new Map((signedUrls ?? []).map(item => [item.path, item.signedUrl]));
  }

  return (data ?? []).map(memory => ({
    id: memory.id,
    galleryId: memory.gallery_id,
    date: memory.memory_date,
    title: memory.title,
    location: memory.location ?? "",
    note: memory.note ?? "",
    media: (memory.media ?? [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(media => {
        const url = urlsByPath.get(media.storage_path);
        if (!url) throw new Error(`Could not create a viewing link for ${media.original_name || "a memory file"}.`);
        return {
          id: media.id,
          url,
          storagePath: media.storage_path,
          type: media.media_type
        };
      })
  }));
}

function Media({ media, className = "" }) {
  if (media.type === "video") {
    return <video className={className} src={media.url} muted controls playsInline />;
  }
  return <img className={className} src={media.url} alt={media.originalName || ""} loading="lazy" />;
}

function App() {
  const [gateState, setGateState] = useState("locked");
  const [gateMessage, setGateMessage] = useState("");
  const [gallery, setGallery] = useState(null);
  const [memories, setMemories] = useState([]);
  const [view, setView] = useState("grid");
  const [selectedDay, setSelectedDay] = useState(null);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [lightboxMedia, setLightboxMedia] = useState(null);
  const [loadingGallery, setLoadingGallery] = useState(false);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [anniversaryInput, setAnniversaryInput] = useState("");
  const dialogRef = useRef(null);
  const lightboxRef = useRef(null);

  useEffect(() => {
    if (gateState !== "unlocked" || !supabase) {
      setGallery(null);
      setMemories([]);
      setLoadingGallery(false);
      return undefined;
    }

    let active = true;
    setGallery(null);
    setMemories([]);
    setLoadingGallery(true);
    setError("");

    (async () => {
      const { data: existingGallery, error: galleryError } = await supabase
        .from("galleries")
        .select("id, title")
        .limit(1)
        .maybeSingle();

      if (galleryError) throw galleryError;
      let nextGallery = existingGallery;
      if (!nextGallery) {
        const { data, error: createError } = await supabase
          .from("galleries")
          .insert({ title: "You & Me" })
          .select("id, title")
          .single();

        if (createError) throw createError;
        nextGallery = data;
      }

      if (active) {
        setGallery(nextGallery);
      }
    })()
      .catch(galleryError => {
        if (active) setError(`Could not load your gallery: ${getErrorMessage(galleryError)}`);
      })
      .finally(() => {
        if (active) setLoadingGallery(false);
      });

    return () => {
      active = false;
    };
  }, [gateState]);

  useEffect(() => {
    if (!gallery || !supabase) {
      setLoadingMemories(false);
      return undefined;
    }

    let active = true;
    setLoadingMemories(true);
    setError("");

    fetchGalleryMemories(gallery.id)
      .then(data => {
        if (active) setMemories(data);
      })
      .catch(loadError => {
        if (active) setError(`Could not load memories: ${getErrorMessage(loadError)}`);
      })
      .finally(() => {
        if (active) setLoadingMemories(false);
      });

    return () => {
      active = false;
    };
  }, [gallery?.id]);

  useEffect(() => () => {
    uploadedFiles.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
  }, [uploadedFiles]);

  const sortedMemories = [...memories].sort((a, b) => b.date.localeCompare(a.date));

  function openDialog() {
    setFormError("");
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function openLightbox(media) {
    setLightboxMedia(media);
    lightboxRef.current?.showModal();
  }

  function handleFiles(event) {
    uploadedFiles.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
    setUploadedFiles(Array.from(event.target.files).map(file => ({
      file,
      previewUrl: URL.createObjectURL(file)
    })));
  }

  function handleGateSubmit(event) {
    event.preventDefault();
    setGateMessage("");
    setError("");
    const form = new FormData(event.currentTarget);
    const anniversaryDate = String(form.get("anniversaryDate") ?? "");

    if (anniversaryDate !== expectedAnniversary) {
      setGateState("denied");
      setGateMessage("That date isn't quite right. This little gallery is just for the two of you.");
      return;
    }

    setGateState("unlocked");
    setAnniversaryInput("");
  }

  function handleLockGallery() {
    setGateState("locked");
    setError("");
    setGallery(null);
    setMemories([]);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!supabase || !gallery) return;

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const date = String(form.get("date") ?? "");
    const title = String(form.get("title") ?? "").trim();
    if (!date || !title) return;

    setBusy(true);
    setFormError("");
    let memoryId = null;
    const uploadedPaths = [];

    try {
      const { data: memory, error: memoryError } = await supabase
        .from("memories")
        .insert({
          gallery_id: gallery.id,
          memory_date: date,
          title,
          location: String(form.get("location") ?? "").trim() || null,
          note: String(form.get("note") ?? "").trim() || null
        })
        .select("id")
        .single();

      if (memoryError) throw memoryError;
      memoryId = memory.id;

      for (const { file } of uploadedFiles) {
        const safeName = file.name.replace(/[^\w.-]+/g, "_");
        const storagePath = `${gallery.id}/${memory.id}/${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from(storageBucket)
          .upload(storagePath, file, {
            cacheControl: "3600",
            contentType: file.type,
            upsert: false
          });

        if (uploadError) throw uploadError;
        uploadedPaths.push(storagePath);

        const { error: metadataError } = await supabase.from("media").insert({
          memory_id: memory.id,
          storage_path: storagePath,
          media_type: file.type.startsWith("video/") ? "video" : "image",
          original_name: file.name,
          mime_type: file.type || null,
          size_bytes: file.size
        });

        if (metadataError) throw metadataError;
      }

      const updatedMemories = await fetchGalleryMemories(gallery.id);
      setMemories(updatedMemories);
      formElement.reset();
      setUploadedFiles([]);
      closeDialog();
    } catch (saveError) {
      const cleanupErrors = [];
      if (uploadedPaths.length > 0) {
        const { error: removeError } = await supabase.storage.from(storageBucket).remove(uploadedPaths);
        if (removeError) cleanupErrors.push(`file cleanup failed: ${removeError.message}`);
      }
      if (memoryId) {
        const { error: deleteError } = await supabase.from("memories").delete().eq("id", memoryId);
        if (deleteError) cleanupErrors.push(`memory cleanup failed: ${deleteError.message}`);
      }
      const cleanupMessage = cleanupErrors.length > 0 ? ` (${cleanupErrors.join("; ")})` : "";
      setFormError(`Could not save this memory: ${getErrorMessage(saveError)}${cleanupMessage}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grain" aria-hidden="true" />

      <header className="topbar">
        <button className="brand" onClick={() => setSelectedDay(null)} aria-label="Go to memories">
          <span className="brand-mark" aria-hidden="true">♥</span>
          <span>You &amp; Me</span>
        </button>
        {gateState === "unlocked" && (
          <div className="account-actions">
            <span className="account-email">Our private space</span>
            <button className="account-button" onClick={handleLockGallery} disabled={busy}>Lock gallery</button>
          </div>
        )}
      </header>

      <main>
        {appConfigError && (
          <section className="account-panel">
            <p className="eyebrow">Setup needed</p>
            <h1>Connect your gallery</h1>
            <p>{appConfigError}</p>
          </section>
        )}

        {!appConfigError && gateState === "denied" && (
          <section className="account-panel">
            <p className="eyebrow">A little mystery</p>
            <h1>This story is for two.</h1>
            <p className="account-description">{gateMessage}</p>
            <button className="save-button create-gallery-button" onClick={() => {
              setGateMessage("");
              setGateState("locked");
            }}>
              Try again
            </button>
          </section>
        )}

        {!appConfigError && gateState !== "denied" && gateState !== "unlocked" && (
          <section className="account-panel">
            <p className="eyebrow">Just for the two of you</p>
            <h1>When did your story begin?</h1>
            <p className="account-description">Enter your anniversary date to open your private gallery.</p>
            <form className="account-form" onSubmit={handleGateSubmit}>
              <label>
                Our anniversary
                <input
                  type="date"
                  name="anniversaryDate"
                  value={anniversaryInput}
                  onChange={event => setAnniversaryInput(event.target.value)}
                  required
                />
              </label>
              {gateMessage && <p className="form-message error-message" role="alert">{gateMessage}</p>}
              <button className="save-button" type="submit" disabled={busy}>
                {busy ? "Checking..." : "Open our memories"}
              </button>
            </form>
          </section>
        )}

        {gateState === "unlocked" && loadingGallery && (
          <section className="account-panel" aria-live="polite">
            <p className="eyebrow">Your little universe</p>
            <h1>Finding your gallery...</h1>
          </section>
        )}

        {gateState === "unlocked" && !loadingGallery && !gallery && (
          <section className="account-panel">
            <p className="eyebrow">A little hiccup</p>
            <h1>We couldn't find your album.</h1>
            <p className="form-message error-message" role="alert">{error || "Check that the Supabase schema and access policies have been applied."}</p>
          </section>
        )}

        {gateState === "unlocked" && gallery && (
          <>
            {error && <p className="app-error" role="alert">{error}</p>}
            {!selectedDay && (
              <>
                <section className="hero">
                  <video className="hero-video" src="/gallaries/6059812664081654829.mp4" autoPlay muted loop playsInline aria-hidden="true" tabIndex={-1} />
                  <div className="hero-copy">
                    <p className="eyebrow">A gallery of us</p>
                    <h1>Moments we<br /><em>keep.</em></h1>
                  </div>
                  <div className="hero-count" aria-live="polite">
                    <strong>{memories.length}</strong>
                    <span>memories<br />together</span>
                  </div>
                </section>

                <section className="timeline-section">
                  <div className="timeline-heading">
                    <h2>{gallery.title || "Our photo album"}</h2>
                    <div className="timeline-actions">
                      <div className="view-controls" aria-label="Timeline controls">
                        <button className={`icon-button ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")} aria-label="Grid view" title="Grid view">
                          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>
                        </button>
                        <button className={`icon-button ${view === "list" ? "active" : ""}`} onClick={() => setView("list")} aria-label="List view" title="List view">
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/></svg>
                        </button>
                      </div>
                      <button className="add-button" onClick={openDialog}>
                        <span aria-hidden="true">+</span>
                        <span>Add memory</span>
                      </button>
                    </div>
                  </div>

                  {loadingMemories ? (
                    <p className="empty-state" aria-live="polite">Gathering your memories...</p>
                  ) : memories.length === 0 ? (
                    <p className="empty-state">Your album is waiting for its first moment.</p>
                  ) : (
                    <div className={`timeline ${view === "list" ? "list-view" : ""}`}>
                      {sortedMemories.map(memory => {
                        const date = formatDate(memory.date);
                        const cover = memory.media[0];
                        return (
                          <button className="memory-card" key={memory.id} onClick={() => setSelectedDay(memory)} aria-label={`Open ${memory.title}`}>
                            <div className="memory-image">
                              {cover && <Media media={cover} />}
                              <div className="memory-date">
                                <strong>{date.day}</strong>
                                <span>{date.month} {date.year}</span>
                              </div>
                            </div>
                            <div className="memory-caption">
                              <div>
                                <h3>{memory.title}</h3>
                                <p>{memory.location || "A special place"}</p>
                              </div>
                              <span className="media-count">{memory.media.length} {memory.media.length === 1 ? "moment" : "moments"}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              </>
            )}

            {selectedDay && (
              <section className="day-view">
                <button className="back-button" onClick={() => setSelectedDay(null)}>
                  <span aria-hidden="true">←</span> Back to timeline
                </button>
                <div className="day-header">
                  <div>
                    <p className="eyebrow">{formatDate(selectedDay.date).weekday}</p>
                    <h2>{formatDate(selectedDay.date).long}</h2>
                  </div>
                  <p className="day-location">{selectedDay.location}</p>
                </div>
                <h3 className="day-memory-title">{selectedDay.title}</h3>
                <div className="day-gallery">
                  {selectedDay.media.map((media, index) => (
                    <div
                      className={`day-media ${index === 0 && selectedDay.media.length > 1 ? "wide" : ""}`}
                      key={media.id}
                      onClick={() => openLightbox(media)}
                    >
                      <Media media={media} />
                    </div>
                  ))}
                  {selectedDay.note && <p className="day-note">{selectedDay.note}</p>}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <dialog className="memory-dialog" ref={dialogRef}>
        <form className="dialog-shell" onSubmit={handleSubmit}>
          <div className="dialog-header">
            <div>
              <p className="eyebrow">New moment</p>
              <h2>Add a memory</h2>
            </div>
            <button className="close-button" type="button" onClick={closeDialog} aria-label="Close">×</button>
          </div>

          <label>Date<input type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
          <label>Title<input type="text" name="title" placeholder="A day to remember" required /></label>
          <label>Location<input type="text" name="location" placeholder="Somewhere special" /></label>
          <label>Note<textarea name="note" rows="3" placeholder="Write about this day..."></textarea></label>
          <label className="file-drop">
            <input type="file" accept="image/*,video/*" multiple onChange={handleFiles} />
            <span className="file-icon" aria-hidden="true">+</span>
            <strong>Add photos or videos</strong>
            <small>{uploadedFiles.length ? `${uploadedFiles.length} file${uploadedFiles.length === 1 ? "" : "s"} selected` : "Choose one or more files"}</small>
          </label>
          <div className="file-preview">
            {uploadedFiles.map(({ file, previewUrl }) => (
              file.type.startsWith("video/")
                ? <video key={`${file.name}-${file.lastModified}`} src={previewUrl} muted />
                : <img key={`${file.name}-${file.lastModified}`} src={previewUrl} alt="" />
            ))}
          </div>
          {formError && <p className="form-message error-message" role="alert">{formError}</p>}
          <button className="save-button" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save memory"}
          </button>
        </form>
      </dialog>

      <dialog className="lightbox" ref={lightboxRef}>
        <button className="lightbox-close" onClick={() => lightboxRef.current?.close()} aria-label="Close">×</button>
        {lightboxMedia && <Media media={lightboxMedia} />}
      </dialog>
    </>
  );
}

export default App;
