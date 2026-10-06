
        const { calculateNextRun, getAutomationStore, validateAutomationSchedule } = await import("../../automation/src");
        if (!validateAutomationSchedule(schedule)) {
          return Response.json({ error: "Invalid automation schedule." }, { status: 400 });
        }

        const nextRunAt = calculateNextRun(schedule);
        const automation = await withAutomationCreationAdmission(userId, () => getAutomationStore().create({ userId, name, prompt, schedule, status: "active", nextRunAt }));
        if (!automation) return Response.json({ error: "Automation limit reached for this user; pause, complete, or delete an existing automation before creating another." }, { status: 429 });
        return Response.json({ automation }, { status: 201 });
      } catch (error) {
        return Response.json({ error: "Automation creation failed" }, { status: 400 });
      }
    }

    const automationMatch = url.pathname.match(/^\/v1\/automations\/users\/([^/]+)\/([^/]+)$/);
    if (automationMatch && request.method === "PATCH") {
      try {
        const userId = decodeBoundedUserId(automationMatch[1]);
        if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
        let id: string;
        try {
          id = decodeURIComponent(automationMatch[2]);
        } catch {
          return Response.json({ error: "Invalid automation ID" }, { status: 400 });
        }
        if (!id || id.length > 200 || new TextEncoder().encode(id).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
          return Response.json({ error: "Invalid automation ID" }, { status: 400 });
        }
        const body = await parseBoundedJson(request);
        const patch: Record<string, unknown> = {};
        if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length > 10) return Response.json({ error: "Automation update contains too many fields." }, { status: 400 });
        if (typeof body?.name === "string") patch.name = body.name.trim();
        if (typeof body?.prompt === "string") patch.prompt = body.prompt.trim();
        if (typeof patch.name === "string" && (patch.name.length > 120 || new TextEncoder().encode(patch.name).byteLength > 512)) return Response.json({ error: "Automation name is too large." }, { status: 400 });
        if (typeof patch.prompt === "string" && (patch.prompt.length > 8000 || new TextEncoder().encode(patch.prompt).byteLength > 32 * 1024)) return Response.json({ error: "Automation prompt is too large." }, { status: 400 });
        if (body?.status === "active" || body?.status === "paused" || body?.status === "completed") patch.status = body.status;
        if (body?.schedule?.type) patch.schedule = body.schedule;
        const { calculateNextRun, getAutomationStore, validateAutomationSchedule } = await import("../../automation/src");
        if (patch.schedule) {
          if (new TextEncoder().encode(JSON.stringify(patch.schedule)).byteLength > 8 * 1024) {
            return Response.json({ error: "Automation schedule is too large." }, { status: 400 });
          }
          if (!validateAutomationSchedule(patch.schedule)) {
            return Response.json({ error: "Invalid automation schedule." }, { status: 400 });
          }
          patch.nextRunAt = calculateNextRun(patch.schedule as any);
        }
        const automation = await getAutomationStore().updateIfIdle(id, userId, patch as any);
        if (!automation) return Response.json({ error: "Automation is currently executing; wait for the active worker to finish." }, { status: 409 });
        return Response.json({ automation });
      } catch (error) {
        return Response.json({ error: "Automation update failed" }, { status: 400 });
      }
    }
