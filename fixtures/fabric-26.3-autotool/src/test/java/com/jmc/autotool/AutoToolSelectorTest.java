package com.jmc.autotool;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

class AutoToolSelectorTest {
	private static final int SLOTS = AutoToolState.HOTBAR_SIZE;

	private static BlockState stoneBlock;
	private static BlockState oakLogBlock;

	@BeforeAll
	static void bootstrapGame() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		stoneBlock = Blocks.STONE.defaultBlockState();
		oakLogBlock = Blocks.OAK_LOG.defaultBlockState();
	}

	private static ToolSpeedSource table(float... speeds) {
		return (slot, target) -> slot >= 0 && slot < speeds.length ? speeds[slot] : 0.0F;
	}

	private static int resolve(float[] speeds, int selected, BlockState target, boolean enabled) {
		return AutoToolSelector.resolveSlot(table(speeds), SLOTS, selected, target, enabled);
	}

	@Test
	@DisplayName("a better tool in another slot is selected")
	void betterToolInAnotherSlotIsSelected() {
		int chosen = resolve(new float[] { 1.0F, 8.0F }, 0, stoneBlock, true);

		assertEquals(1, chosen);
	}

	@Test
	@DisplayName("no suitable tool leaves the current slot unchanged")
	void noSuitableToolKeepsCurrentSlot() {
		int chosen = resolve(new float[] { 1.0F, 1.0F, 0.0F }, 0, stoneBlock, true);

		assertEquals(0, chosen);
	}

	@Test
	@DisplayName("an equally suitable tool causes no switch")
	void equallySuitableToolDoesNotSwitch() {
		int chosen = resolve(new float[] { 8.0F, 8.0F }, 0, stoneBlock, true);

		assertEquals(0, chosen);
	}

	@Test
	@DisplayName("a non-tool item is ignored")
	void nonToolItemIsIgnored() {
		int chosen = resolve(new float[] { 8.0F, 1.0F }, 0, stoneBlock, true);

		assertEquals(0, chosen);
	}

	@Test
	@DisplayName("empty slots are ignored")
	void emptySlotsAreIgnored() {
		int chosen = resolve(new float[] { 8.0F, 0.0F, 0.0F }, 0, stoneBlock, true);

		assertEquals(0, chosen);
	}

	@Test
	@DisplayName("a disabled feature never switches")
	void disabledFeatureNeverSwitches() {
		int chosen = resolve(new float[] { 1.0F, 8.0F }, 0, stoneBlock, false);

		assertEquals(0, chosen);
	}

	@Test
	@DisplayName("the fastest of several candidates is selected")
	void fastestCandidateIsSelected() {
		int chosen = resolve(new float[] { 1.0F, 4.0F, 9.0F, 2.0F }, 1, stoneBlock, true);

		assertEquals(2, chosen);
	}

	@Test
	@DisplayName("an empty held slot still allows a switch")
	void emptyHeldSlotAllowsSwitch() {
		int chosen = resolve(new float[] { 0.0F, 8.0F }, 0, stoneBlock, true);

		assertEquals(1, chosen);
	}

	@Test
	@DisplayName("the correct tool class is preferred for its block")
	void correctToolClassIsPreferred() {
		int chosen = resolve(new float[] { 2.0F, 7.0F }, 0, oakLogBlock, true);

		assertEquals(1, chosen);
	}

	@Test
	@DisplayName("a missing target never switches")
	void missingTargetNeverSwitches() {
		assertEquals(AutoToolSelector.NO_CHANGE, AutoToolSelector.selectSlot(table(1.0F, 8.0F), SLOTS, 0, null, true));
	}

	@Test
	@DisplayName("an out of range selected slot never switches")
	void invalidSelectedSlotNeverSwitches() {
		ToolSpeedSource speeds = table(8.0F);

		assertEquals(AutoToolSelector.NO_CHANGE, AutoToolSelector.selectSlot(speeds, SLOTS, -1, stoneBlock, true));
		assertEquals(AutoToolSelector.NO_CHANGE, AutoToolSelector.selectSlot(speeds, SLOTS, 99, stoneBlock, true));
		assertEquals(AutoToolSelector.NO_CHANGE, AutoToolSelector.selectSlot(speeds, 0, 0, stoneBlock, true));
	}

	@Test
	@DisplayName("a negative speed is treated as no speed")
	void negativeSpeedIsIgnored() {
		int chosen = resolve(new float[] { 1.0F, -5.0F }, 0, stoneBlock, true);

		assertEquals(0, chosen);
	}
}
