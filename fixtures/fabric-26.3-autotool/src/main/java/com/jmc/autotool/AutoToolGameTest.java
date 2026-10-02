package com.jmc.autotool;

import java.util.ArrayList;
import java.util.List;

import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;

import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

public final class AutoToolGameTest implements FabricClientGameTest {
	public static final String TEST_NAME = "jmc_autotool";

	private static final List<String> CHECKS = new ArrayList<>();

	public static List<String> passedChecks() {
		return List.copyOf(CHECKS);
	}

	@Override
	public void runTest(ClientGameTestContext context) {
		context.waitFor(client -> client.getResourceManager() != null, 2400);
		context.runOnClient(client -> assertLoaderStarted(client));
		context.runOnClient(client -> assertEntrypointInitialized());
		context.runOnClient(client -> assertRegistryComplete());
		context.runOnClient(client -> assertToggleUsable());
		context.runOnClient(client -> assertSelectorUsable());
		context.waitTick();
	}

	private static void assertLoaderStarted(net.minecraft.client.Minecraft client) {
		require(client != null, "client-instance-present");
		require(net.fabricmc.loader.api.FabricLoader.getInstance() != null, "fabric-loader-present");
		require(
			net.fabricmc.loader.api.FabricLoader.getInstance().getModContainer("jmc_autotool").isPresent(),
			"mod-discovered-by-fabric-loader"
		);
	}

	private static void assertEntrypointInitialized() {
		require(AutoToolClient.isInitialized(), "entrypoint-initialized");
	}

	private static void assertRegistryComplete() {
		require(AutoToolRegistry.isRegistered(), "registry-complete");
		List<String> ids = AutoToolRegistry.registeredIds();
		require(ids.contains("jmc_autotool"), "mod-id-registered");
		require(ids.contains(AutoToolRegistry.COMMAND_ROOT), "command-registered");
		require(ids.contains(AutoToolRegistry.TICK_HOOK), "tick-hook-registered");
		require(ids.contains(AutoToolRegistry.CLIENT_GAME_TEST), "game-test-registered");
	}

	private static void assertToggleUsable() {
		AutoToolState state = AutoToolState.instance();
		boolean initial = state.isEnabled();
		state.toggle();
		require(state.isEnabled() != initial, "toggle-changes-state");
		state.setEnabled(false);
		require(state.isEnabled() == false, "disable-works");
		state.setEnabled(true);
		require(state.isEnabled(), "enable-works");
		require(state.status().contains("JMC AutoTool"), "status-reports-state");
		state.resetCounters();
		require(state.lastSwitchCount() == 0, "counters-resettable");
	}

	private static void assertSelectorUsable() {
		BlockState obsidian = Blocks.OBSIDIAN.defaultBlockState();
		require(obsidian != null, "real-block-state-available");

		ToolSpeedSource speeds = (slot, target) -> switch (slot) {
			case 0 -> 1.0F;
			case 1 -> 8.0F;
			default -> 0.0F;
		};
		require(AutoToolSelector.resolveSlot(speeds, AutoToolState.HOTBAR_SIZE, 0, obsidian, true) == 1, "selector-chooses-better-slot");
		require(AutoToolSelector.resolveSlot(speeds, AutoToolState.HOTBAR_SIZE, 0, obsidian, false) == 0, "selector-honours-disabled");
		require(
			AutoToolSelector.selectSlot(speeds, AutoToolState.HOTBAR_SIZE, 0, obsidian, true) == 1,
			"selector-returns-explicit-slot"
		);

		AutoToolState.instance().recordSwitch(1);
		require(AutoToolState.instance().lastSwitchCount() == 1, "switch-recorded");
		require(AutoToolState.instance().lastSelectedSlot() == 1, "switch-slot-recorded");
		AutoToolState.instance().resetCounters();
	}

	private static void require(boolean condition, String name) {
		if (condition == false) {
			throw new IllegalStateException("AutoTool runtime check failed: " + name);
		}

		CHECKS.add(name);
	}
}
