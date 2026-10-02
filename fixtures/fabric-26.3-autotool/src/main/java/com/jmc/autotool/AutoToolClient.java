package com.jmc.autotool;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;

import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;

public final class AutoToolClient implements ClientModInitializer {
	public static final String COMMAND = "jmctool";

	private static boolean initialized;

	@Override
	public void onInitializeClient() {
		AutoToolRegistry.register();
		ClientTickEvents.END_CLIENT_TICK.register(AutoToolClient::onEndTick);
		ClientCommandRegistrationCallback.EVENT.register(AutoToolClient::registerCommand);
		initialized = true;
	}

	public static boolean isInitialized() {
		return initialized;
	}

	private static void onEndTick(Minecraft client) {
		if (client.player == null || client.level == null) {
			return;
		}

		BlockState target = targetBlockState(client);

		if (target == null) {
			return;
		}

		Inventory inventory = client.player.getInventory();
		int selected = inventory.getSelectedSlot();
		int chosen = AutoToolSelector.selectSlot(
			(slot, block) -> HotbarSpeedSource.speedOf(inventory, slot, block),
			AutoToolState.HOTBAR_SIZE,
			selected,
			target,
			AutoToolState.instance().isEnabled()
		);

		if (chosen != AutoToolSelector.NO_CHANGE) {
			inventory.setSelectedSlot(chosen);
			AutoToolState.instance().recordSwitch(chosen);
		}
	}

	private static BlockState targetBlockState(Minecraft client) {
		HitResult hit = client.hitResult;

		if (hit == null || hit.getType() != HitResult.Type.BLOCK) {
			return null;
		}

		if (client.options.keyAttack.isDown() == false) {
			return null;
		}

		if (hit instanceof BlockHitResult blockHit) {
			return client.level.getBlockState(blockHit.getBlockPos());
		}

		return null;
	}

	private static void registerCommand(
		CommandDispatcher<FabricClientCommandSource> dispatcher,
		CommandBuildContext context
	) {
		dispatcher.register(
			LiteralArgumentBuilder.<FabricClientCommandSource>literal(COMMAND)
				.executes(source -> {
					source.getSource().sendFeedback(Component.literal(AutoToolState.instance().status()));
					return 1;
				})
				.then(LiteralArgumentBuilder.<FabricClientCommandSource>literal("on")
					.executes(source -> {
						AutoToolState.instance().setEnabled(true);
						source.getSource().sendFeedback(Component.literal("JMC AutoTool enabled"));
						return 1;
					}))
				.then(LiteralArgumentBuilder.<FabricClientCommandSource>literal("off")
					.executes(source -> {
						AutoToolState.instance().setEnabled(false);
						source.getSource().sendFeedback(Component.literal("JMC AutoTool disabled"));
						return 1;
					}))
				.then(LiteralArgumentBuilder.<FabricClientCommandSource>literal("status")
					.executes(source -> {
						source.getSource().sendFeedback(Component.literal(AutoToolState.instance().status()));
						return 1;
					}))
		);
	}
}
